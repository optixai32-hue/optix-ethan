/**
 * processMessage — the chat turn: TypeScript port of
 * backend/onyx/chat/process_message.py (turn setup, packet emission, error
 * packets, persistence) + backend/onyx/chat/agent.py (the agent loop:
 * stream -> accumulate -> tool calls -> tool results -> repeat, capped at
 * MAX_LLM_CYCLES; this port uses 8 iterations per the port contract) +
 * backend/onyx/chat/persistence.py (response saving) and
 * backend/onyx/server/query_and_chat/chat_backend.py (SSE delivery shape).
 *
 * Flow (mirroring the Python turn):
 *   1. Load/validate the session + persona, append the user message.
 *   2. System prompt = persona.system_prompt + cited context built from the
 *      SearchDocs gathered so far (rag/prompt_builder.buildCitedSystemPrompt).
 *   3. Agent loop (max 8 iterations, AbortSignal + wall-clock escape hatches):
 *        provider.stream() with tool specs from the registry; text deltas
 *        accumulate in StreamBuffer; tool_call fragments accumulate likewise.
 *        When the model requests tools, each tool runs (Tool.run) and its
 *        result is appended as an LLMMessage role 'tool' with tool_call_id;
 *        docs the tools report join the citation mapping. Otherwise the step
 *        is final: deltas replay through the citation processor, emitting
 *        agent_response_delta + citation_info packets.
 *   4. The final answer persists (appendChatMessage + citations) and the
 *      stream emits: agent_response_start -> deltas -> citation_info ->
 *      final -> stop, then SSE `data: [DONE]\n\n`.
 *   5. Exceptions emit an error packet (StreamingError semantics) and a stop
 *      packet before [DONE]; the failure also persists to the message row.
 */

import type {
  AuthContext,
  Citation,
  Persona,
  SearchDoc,
} from "../types/domain";
import { getLogger } from "../utils/logger";
import {
  ChatRuntimeError,
  InvalidMessageExceptionError,
  LLMGenerationError,
  OnyxError,
} from "../utils/errors";
import { getLLMProvider, resolveDefaultProvider } from "../llm/factory";
import type { LLMMessage, LLMToolSpec } from "../llm/types";
import { StreamEmitter } from "./emitter";
import { StreamBuffer } from "./stream_buffer";
import type { Packet } from "./models";
import type { Tool, ToolContext } from "../tools/interface";
import {
  appendChatMessage,
  getChatMessages,
  getChatSession,
  updateChatMessage,
} from "./persistence";
import { buildHistory } from "./history_store";
import { getDefaultPersona, getPersona } from "../agents/personas";
import { buildCitedSystemPrompt } from "../rag/prompt_builder";
import {
  buildCitationsForAnswer,
  DynamicCitationProcessor,
} from "../rag/citations";
import type { CitationInfoEvent } from "../rag/citations";
import { getTool, listTools } from "../tools/registry";
import { registerBuiltInTools } from "../tools/built_in_tools";
import { queryOne } from "../db/client";

const logger = getLogger("chat.process_message");

/**
 * Port contract: 8 agent iterations (Python: MAX_LLM_CYCLES = 30 in
 * onyx/configs/chat_configs.py; the port caps lower per the task spec).
 */
export const MAX_AGENT_STEPS = 8;
/** Wall-clock escape hatch for a whole turn (ms). */
const MAX_TURN_MS = 5 * 60 * 1000;
/** SSE keepalive interval so proxies don't kill a silent stream. */
const HEARTBEAT_INTERVAL_MS = 15_000;

export interface ProcessMessageOptions {
  user: AuthContext;
  chatSessionId: string;
  message: string;
  personaId?: number;
  signal?: AbortSignal;
  /** Wire framing: "sse" (data: frames, legacy port surface) or "ndjson"
   * (newline-delimited AnswerStreamPart, the original /chat/send-chat-message
   * wire format consumed by the original frontend). */
  wireFormat?: "sse" | "ndjson";
  /** SendMessageRequest.deep_research — run the multi-step research loop
   * (dr_loop.py port) before the final answer. */
  deepResearch?: boolean;
  /** SendMessageRequest.forced_tool_id — numeric ToolSnapshot id the user
   * pinned; the tool runs on the user message before the agent loop. */
  forcedToolId?: number;
  /** SendMessageRequest.allowed_tool_ids — numeric ToolSnapshot ids of the
   * enabled tools; when present only those tools are offered to the model. */
  allowedToolIds?: number[];
  /** SendMessageRequest.llm_override — per-message model/temperature choice
   * from the toolbar model selector. */
  llmOverride?: {
    temperature?: number | null;
    model_provider?: string | null;
    model_version?: string | null;
    model_configuration_id?: number | null;
  };
}

function sseFrame(packet: Packet): string {
  return `data: ${JSON.stringify(packet)}\n\n`;
}

/**
 * Port of the original wire format: each stream line is one AnswerStreamPart
 * (chat/models.py:606) — either a bare MessageResponseIDInfo/CreateChatSessionID/
 * StreamingError or a wrapped Packet {placement, obj} with obj discriminated on
 * "type" (server/query_and_chat/streaming_models.py).
 */
function ndjsonFrame(packet: Packet): string {
  const placement = {
    turn_index: packet.ind ?? 0,
    tab_index: 0,
    sub_turn_index: packet.subInd ?? null,
    model_index: 0,
  };
  let obj: Record<string, unknown> | null = null;
  try {
    obj = packet.packet ? JSON.parse(packet.packet) : null;
  } catch {
    obj = typeof packet.packet === "string" ? { message: packet.packet } : null;
  }
  switch (packet.type) {
    case "user_message":
      // Not part of the v5.1.3 protocol (no USER_MESSAGE PacketObj exists);
      // kept only as a defensive no-op so a legacy emitter call can never
      // poison the frontend's group classification again.
      return "";
    case "agent_response_start":
      // AgentResponseStart (streaming_models.py): final_documents +
      // pre_answer_processing_seconds only.
      return (
        JSON.stringify({
          placement,
          obj: {
            type: "message_start",
            final_documents: obj?.final_documents ?? null,
            pre_answer_processing_seconds: obj?.pre_answer_processing_seconds ?? null,
          },
        }) + "\n"
      );
    case "agent_response_delta":
      // The simple-send path carries the delta text in `message`; the
      // sendObject path (if ever used) carries it in obj.content.
      return (
        JSON.stringify({
          placement,
          obj: {
            type: "message_delta",
            content:
              packet.message ||
              ((obj?.content as string | undefined) ?? ""),
          },
        }) + "\n"
      );
    case "citation_info":
      return (
        JSON.stringify({
          placement,
          obj: {
            type: "citation_info",
            citation_number: obj?.citation_number ?? 0,
            document_id: obj?.document_id ?? "",
          },
        }) + "\n"
      );
    case "stop":
      return (
        JSON.stringify({
          placement,
          obj: { type: "stop", stop_reason: obj?.stop_reason ?? null },
        }) + "\n"
      );
    case "chat_heartbeat":
      return JSON.stringify({ placement, obj: { type: "chat_heartbeat" } }) + "\n";
    case "error":
      // StreamingError is a bare (unwrapped) AnswerStreamPart
      return (
        JSON.stringify({
          error: obj?.detail ?? obj?.message ?? obj?.error ?? "Unknown error",
          stack_trace: (obj?.stack_trace as string | undefined) ?? "",
          error_code: (obj?.error_code as string | null | undefined) ?? null,
          is_retryable: (obj?.is_retryable as boolean | undefined) ?? false,
          details: (obj?.details as Record<string, unknown> | null | undefined) ?? null,
        }) + "\n"
      );
    default: {
      // Tool progress packets (search_tool_*, custom_tool_*, ...) arrive via
      // the ToolContext.emit contract with the JSON payload in `message`.
      let payload: Record<string, unknown> = {};
      if (packet.packet) {
        try {
          const parsed: unknown = JSON.parse(packet.packet);
          if (parsed && typeof parsed === "object") {
            payload = parsed as Record<string, unknown>;
          }
        } catch {
          payload = {};
        }
      } else if (packet.message) {
        try {
          const parsed: unknown = JSON.parse(packet.message);
          if (parsed && typeof parsed === "object") {
            payload = parsed as Record<string, unknown>;
          } else {
            payload = { message: packet.message };
          }
        } catch {
          payload = { message: packet.message };
        }
      }
      return (
        JSON.stringify({ placement, obj: { ...payload, type: packet.type } }) +
        "\n"
      );
    }
  }
}

/** Merge docs reported by tools into the citation mapping (renumber-safe). */
function mergeGatheredDocs(
  gathered: SearchDoc[],
  mapping: Map<number, SearchDoc>,
  incoming: SearchDoc[],
): void {
  const known = new Set(gathered.map((d) => d.document_id));
  let next = mapping.size > 0 ? Math.max(...mapping.keys()) + 1 : 1;
  for (const doc of incoming) {
    if (!doc || known.has(doc.document_id)) continue;
    known.add(doc.document_id);
    gathered.push(doc);
    mapping.set(next, doc);
    next += 1;
  }
}

/** Parse tool-call arguments JSON defensively. */
function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return {};
  }
}

/**
 * Resolve the provider + model for this turn (process_message.py
 * _select_models + get_llm_for_persona overrides):
 *   1. Per-message llm_override.model_configuration_id -> the configured row.
 *   2. Per-message llm_override.model_version (+ optional model_provider).
 *   3. Persona-level llm_model_version_override.
 *   4. The DB-backed default provider/model.
 * Returns the provider plus the display model name for message attribution.
 */
async function resolveTurnModel(
  persona: Persona,
  override: ProcessMessageOptions["llmOverride"],
): Promise<{ provider: Awaited<ReturnType<typeof getLLMProvider>>; modelName: string }> {
  const personaOverride = persona.llm_model_version_override || undefined;

  if (override?.model_configuration_id) {
    const row = await queryOne<{
      name: string;
      provider: string;
      llm_provider_default: string | null;
    }>(
      `SELECT mc.name, lp.provider, lp.default_model_name AS llm_provider_default
       FROM model_configuration mc
       JOIN llm_provider lp ON lp.id = mc.llm_provider_id
       WHERE mc.id = $1`,
      [override.model_configuration_id],
    );
    if (row) {
      return {
        provider: await getLLMProvider(row.provider, row.name),
        modelName: row.name,
      };
    }
  }

  if (override?.model_version && override.model_version !== "default") {
    return {
      provider: await getLLMProvider(
        override.model_provider ?? undefined,
        override.model_version,
      ),
      modelName: override.model_version,
    };
  }

  if (personaOverride) {
    return {
      provider: await getLLMProvider(undefined, personaOverride),
      modelName: personaOverride,
    };
  }

  const def = await resolveDefaultProvider();
  return {
    provider: await getLLMProvider(def.providerId, def.modelName),
    modelName: def.modelName,
  };
}

/**
 * Run one tool directly and return its text result (shared by forced_tool_id
 * pre-runs and Deep Research sub-agent searches). Gathered SearchDocs merge
 * into the citation mapping; tool progress packets land under (turn, subTurn)
 * so the frontend nests them inside the Deep Research timeline. The result is
 * fed back to the model as a user-role context message — a bare tool message
 * would be invalid without a preceding assistant tool_calls turn.
 */
async function runToolDirect(
  tool: Tool,
  args: Record<string, unknown>,
  opts: {
    userId: string;
    chatSessionId: string;
    turn: number;
    subTurn?: number;
    emitter: StreamEmitter;
    gatheredDocs: SearchDoc[];
    citationMapping: Map<number, SearchDoc>;
    toolCallId?: string;
  },
): Promise<string> {
  const toolCallId = opts.toolCallId ?? `${tool.name}-${opts.turn}`;
  const emitPacket = (
    packetType: string,
    message: string,
  ): void => {
    if (opts.subTurn !== undefined) {
      opts.emitter.sendRawSub(packetType, opts.turn, opts.subTurn, message);
    } else {
      opts.emitter.sendRaw(packetType, opts.turn, message);
    }
  };
  const toolContext: ToolContext = {
    userId: opts.userId,
    chatSessionId: opts.chatSessionId,
    emit: (packetType, message) => {
      if (packetType === "search_tool_documents_delta") {
        try {
          const parsed: unknown = JSON.parse(message);
          if (
            parsed &&
            typeof parsed === "object" &&
            Array.isArray((parsed as { documents?: unknown }).documents)
          ) {
            mergeGatheredDocs(
              opts.gatheredDocs,
              opts.citationMapping,
              (parsed as { documents: SearchDoc[] }).documents,
            );
          }
        } catch {
          // ignore malformed doc payloads
        }
      }
      emitPacket(packetType, message);
    },
  };

  try {
    const result = await tool.run(args, toolContext);
    return result.content;
  } catch (err) {
    logger.warning("direct tool execution failed", {
      tool: tool.name,
      error: String(err),
    });
    return `Error: tool "${tool.name}" failed: ${String(err)}`;
  }
}

/**
 * SearchDoc -> SavedSearchDoc (context/search/models.py:456): the wire shape
 * the original frontend expects in context_docs / final_documents.
 */
function toSavedSearchDoc(doc: SearchDoc): Record<string, unknown> {
  return {
    document_id: doc.document_id,
    chunk_ind: doc.chunk_ind ?? doc.chunk_id ?? 0,
    semantic_identifier: doc.semantic_identifier ?? doc.title ?? "",
    link: doc.link ?? null,
    blurb: doc.blurb ?? "",
    source_type: doc.source_type,
    boost: 0,
    hidden: false,
    metadata: doc.metadata ?? {},
    score: doc.score ?? 0,
    is_relevant: true,
    relevance_explanation: "",
    match_highlights: [],
    source_types: null,
    updated_at: doc.doc_updated_at ?? null,
    db_doc_id: 0,
    is_internet: doc.source_type === "web",
  };
}

export async function processMessage(
  opts: ProcessMessageOptions,
): Promise<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder();
  const runAbort = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) runAbort.abort();
    else opts.signal.addEventListener("abort", () => runAbort.abort(), { once: true });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const push = (frame: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          closed = true;
        }
      };
      const emitPacket = (packet: Packet) => {
        push(opts.wireFormat === "ndjson" ? ndjsonFrame(packet) : sseFrame(packet));
      };
      const heartbeat = setInterval(() => {
        push(
          opts.wireFormat === "ndjson"
            ? ndjsonFrame(emitter.heartbeat(0))
            : sseFrame(emitter.heartbeat(0)),
        );
      }, HEARTBEAT_INTERVAL_MS);

      // The emitter's subscriber pushes every packet to the SSE wire.
      const emitter = new StreamEmitter({
        onPacket: emitPacket,
      });

      const turn = async (): Promise<void> => {
        const turnStartedAt = Date.now();
        let stepBuffer: StreamBuffer | null = null;
        try {
          registerBuiltInTools();

          if (!opts.message.trim()) {
            throw new InvalidMessageExceptionError();
          }

          // ---- Turn setup (process_message.py::_load_session / _select_models)
          const session = await getChatSession(opts.chatSessionId, opts.user.user.id);
          let persona: Persona;
          // DEFAULT_PERSONA_ID = 0 (configs/constants.py): 0/null/undefined
          // all resolve to the default persona.
          const personaId = opts.personaId ?? session.persona_id;
          persona =
            personaId !== null && personaId !== undefined && personaId !== 0
              ? await getPersona(personaId)
              : await getDefaultPersona();

          const userMessage = await appendChatMessage(session.id, opts.message, "user");
          // NOTE (v5.1.3 fidelity): no wrapped `user_message` packet exists in the
          // original protocol — the first stream part is the bare
          // MessageResponseIDInfo below. Emitting a synthetic wrapped packet
          // here poisoned the frontend's group classification (the first packet
          // of group 0-0 was neither a tool nor a display packet, so the answer's
          // display group was never created).
          if (opts.wireFormat === "ndjson") {
            push(
              JSON.stringify({
                user_message_id: userMessage.id,
                reserved_assistant_message_id: userMessage.id,
              }) + "\n",
            );
          }

          // ---- Model selection (process_message.py _select_models): per-message
          // llm_override first, then persona override, then the DB default.
          const { provider, modelName: resolvedModelName } =
            await resolveTurnModel(persona, opts.llmOverride);

          // Tool offering: when the user enabled a specific subset via the
          // ToolsPopover, allowed_tool_ids carries the numeric ToolSnapshot
          // ids (buildToolSnapshots order = registry order) to offer.
          const allTools = listTools();
          let tools = allTools;
          if (opts.allowedToolIds && opts.allowedToolIds.length > 0) {
            const allowed = new Set(opts.allowedToolIds);
            const byIndex = allTools.filter(
              (_t, index) => allowed.has(index + 1) || allowed.has(index),
            );
            if (byIndex.length > 0) tools = byIndex;
          }
          const toolSpecs: LLMToolSpec[] = tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          }));
          const toolById = new Map(tools.map((t) => [t.id, t] as const));

          // Citation state gathered across the loop (agent.py SearchContext).
          const gatheredDocs: SearchDoc[] = [];
          const citationMapping = new Map<number, SearchDoc>();

          // Persisted history (chat_message rows, user message included) +
          // in-memory assistant/tool messages from this turn's tool loop.
          const rows = await getChatMessages(session.id);
          const inMemory: LLMMessage[] = [];

          // Tool context factory — used by the in-loop tool executions below.
          // `turn` is the llm_cycle_count of the original placement semantics
          // (llm_loop.py: tool packets carry the turn of the LLM step that
          // called them).
          const makeToolContext = (turn: number) => ({
            userId: opts.user.user.id,
            chatSessionId: session.id,
            emit: (packetType: string, message: string): void => {
              if (packetType === "search_tool_documents_delta") {
                try {
                  const parsed: unknown = JSON.parse(message);
                  if (
                    parsed &&
                    typeof parsed === "object" &&
                    Array.isArray(
                      (parsed as { documents?: unknown }).documents,
                    )
                  ) {
                    mergeGatheredDocs(
                      gatheredDocs,
                      citationMapping,
                      (parsed as { documents: SearchDoc[] }).documents,
                    );
                  }
                } catch {
                  // ignore malformed doc payloads
                }
              }
              // Forward tool progress to the user stream as a packet.
              emitter.sendRaw(packetType, turn, message);
            },
          });

          // ---- Forced tool (SendMessageRequest.forced_tool_id): run the
          // pinned tool on the user message before the agent loop and feed
          // its result back as a user-role context message (upstream
          // injects forced tool output into the prompt context the same way).
          if (opts.forcedToolId) {
            const forcedTool =
              allTools.find((_t, index) => index + 1 === opts.forcedToolId) ??
              getTool(String(opts.forcedToolId));
            if (forcedTool) {
              emitter.sendObject("tool_call_debug", 0, {
                tool_call_id: `forced-${forcedTool.name}`,
                tool_name: forcedTool.name,
                tool_args: { query: opts.message },
              });
              const forcedResult = await runToolDirect(forcedTool, { query: opts.message }, {
                userId: opts.user.user.id,
                chatSessionId: session.id,
                turn: 0,
                emitter,
                gatheredDocs,
                citationMapping,
              });
              inMemory.push({
                role: "user",
                content:
                  `[Tool ${forcedTool.displayName} was run on the user's message. ` +
                  `Use its result when answering.]\n${forcedResult}`,
              });
            }
          }

          // ---- Deep Research (dr_loop.py port): plan -> research agents
          // (search + intermediate report per sub-question) -> final answer
          // through the normal agent loop below. Packet vocabulary matches
          // streaming_models.py: deep_research_plan_* at turn 0, each
          // research agent at its own turn with nested search tool calls on
          // sub-turns, then agent_response_* for the final answer.
          const deepResearchContext: string[] = [];
          // The final answer streams at the first turn AFTER the research
          // turns — emitting it at turn 0 would collide with the plan packets
          // and the frontend would never open the answer's display group.
          let answerTurnBase = 0;
          if (opts.deepResearch) {
            const runPlain = async (
              messages: LLMMessage[],
            ): Promise<StreamBuffer> => {
              const buffer = new StreamBuffer();
              for await (const event of provider.stream(messages, {
                signal: runAbort.signal,
              })) {
                if (event.delta) buffer.processToken(event.delta);
                if (event.done) break;
                if (
                  event.finish_reason === "stop" ||
                  event.finish_reason === "length"
                ) {
                  break;
                }
              }
              return buffer;
            };

            // Phase 1 — plan (turn 0).
            emitter.sendObject("deep_research_plan_start", 0, {});
            const planBuffer = await runPlain([
              {
                role: "user",
                content:
                  `You are the Deep Research planner. Break the user's research request ` +
                  `into 2 to 4 focused, self-contained research questions (one per line, ` +
                  `no numbering, no extra prose) that together fully cover it. Request: ${opts.message}`,
              },
            ]);
            for (const delta of planBuffer.getDeltas()) {
              emitter.sendObject("deep_research_plan_delta", 0, {
                content: delta,
              });
            }
            emitter.sendObject("section_end", 0, {});
            const subQuestions = planBuffer
              .fullResponse()
              .split("\n")
              .map((line) => line.replace(/^[\s\-*>\d.]+/, "").trim())
              .filter((line) => line.length > 3)
              .slice(0, 4);
            if (subQuestions.length === 0) subQuestions.push(opts.message);

            // Phase 2 — research agents (one turn each).
            const webSearchToolDef =
              getTool("web_search") ?? tools.find((t) => t.name === "web_search");
            const internalSearchToolDef =
              getTool("search_internal") ??
              tools.find((t) => t.name === "search_internal");

            for (let q = 0; q < subQuestions.length; q += 1) {
              if (runAbort.signal.aborted) break;
              const turn = q + 1;
              const subQuestion = subQuestions[q];
              emitter.sendObject("research_agent_start", turn, {
                research_task: subQuestion,
              });

              // Nested search calls on sub-turns (ResearchAgentRenderer groups
              // them by sub_turn_index).
              const searchFindings: string[] = [];
              let subTurn = 0;
              for (const searchToolDef of [internalSearchToolDef, webSearchToolDef]) {
                if (!searchToolDef || runAbort.signal.aborted) continue;
                const result = await runToolDirect(searchToolDef, { query: subQuestion }, {
                  userId: opts.user.user.id,
                  chatSessionId: session.id,
                  turn,
                  subTurn,
                  emitter,
                  gatheredDocs,
                  citationMapping,
                  toolCallId: `dr-${q}-${searchToolDef.name}`,
                });
                searchFindings.push(result);
                emitter.sendObjectSub("section_end", turn, subTurn, {});
                subTurn += 1;
              }

              // Intermediate report (parent packets of this turn).
              emitter.sendObject("intermediate_report_start", turn, {});
              const reportBuffer = await runPlain([
                {
                  role: "user",
                  content:
                    `You are a research sub-agent. Using ONLY the search findings below, ` +
                    `write a concise research summary (a few sentences to a short paragraph, ` +
                    `cite sources as [n] where the findings number them) for the task: "${subQuestion}"` +
                    `\n\nFindings:\n${searchFindings.join("\n\n") || "(no results found)"}`,
                },
              ]);
              for (const delta of reportBuffer.getDeltas()) {
                emitter.sendObject("intermediate_report_delta", turn, {
                  content: delta,
                });
              }
              const reportText = reportBuffer.fullResponse();
              deepResearchContext.push(
                `Research task: ${subQuestion}\nSummary: ${reportText}`,
              );
              emitter.sendObject("intermediate_report_cited_docs", turn, {
                cited_docs: gatheredDocs.map(toSavedSearchDoc),
              });
              emitter.sendObject("section_end", turn, {});
            }

            // The final answer starts at the next free turn.
            answerTurnBase = subQuestions.length + 1;

            // Feed the research summary into the final answer as context.
            if (deepResearchContext.length > 0) {
              inMemory.push({
                role: "user",
                content:
                  `[Deep Research findings — use these (and their [n] citations) to write ` +
                  `the final answer to the user's original request.]\n` +
                  deepResearchContext.join("\n\n"),
              });
            }
          }

          // NOTE (upstream fidelity — llm_loop.py:929-945): there is NO forced
          // retrieval step before the agent loop. Onyx offers the Search tool
          // to the model with tool_choice=AUTO and the model itself decides
          // when to search. A forced pre-search made every single turn show
          // "Searching internal documents" (even for greetings), burned one
          // LLM cycle per turn, and failed on deployments without a vector DB.
          // Search still happens — as a normal tool call inside the loop —
          // whenever the model judges the question document-related.

          // ---- Agent loop (agent.py ChatAgent; escape hatches: max steps,
          // AbortSignal, wall-clock deadline)
          for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
            if (runAbort.signal.aborted) {
              throw new ChatRuntimeError("Chat turn was aborted");
            }
            if (Date.now() - turnStartedAt > MAX_TURN_MS) {
              throw new ChatRuntimeError("Chat turn exceeded its time limit");
            }

            const systemPrompt = buildCitedSystemPrompt(
              persona.system_prompt,
              gatheredDocs,
            );
            const llmMessages: LLMMessage[] = [
              ...buildHistory(rows, systemPrompt),
              ...inMemory,
            ];
            // Last iteration: no tools offered (port of tool_choice=NONE on
            // the final step, agent.py _prepare_step).
            const offerTools = step < MAX_AGENT_STEPS - 1;

            stepBuffer = new StreamBuffer();
            for await (const event of provider.stream(llmMessages, {
              ...(offerTools ? { tools: toolSpecs } : {}),
              signal: runAbort.signal,
            })) {
              if (event.delta) stepBuffer.processToken(event.delta);
              if (event.tool_calls) {
                for (const fragment of event.tool_calls) {
                  stepBuffer.processToolCallDelta({
                    id: fragment.id || null,
                    name: fragment.name || null,
                    argumentsDelta: fragment.arguments || null,
                  });
                }
              }
              if (event.done) break;
              if (
                event.finish_reason === "stop" ||
                event.finish_reason === "tool_calls" ||
                event.finish_reason === "length"
              ) {
                break;
              }
            }

            const toolCalls = stepBuffer.getToolCalls().filter((c) => c.name);
            // Placement turn for this LLM cycle (llm_loop.py:1125 —
            // turn_index = llm_cycle_count; cycle 0 is the first LLM step, so
            // agent-loop step N runs at turn N; tools called from this step
            // share its turn). In Deep Research mode the research agents own
            // turns 0..N, so the answer starts at N+1.
            const cycleTurn = answerTurnBase + step;

            if (toolCalls.length > 0 && offerTools) {
              inMemory.push({
                role: "assistant",
                content: stepBuffer.fullResponse(),
                tool_calls: toolCalls,
              });
              let callIndex = 0;
              for (const call of toolCalls) {
                const toolCallId = call.id || `${call.name}-${callIndex}`;
                callIndex += 1;
                emitter.sendObject("tool_call_debug", cycleTurn, {
                  tool_call_id: toolCallId,
                  tool_name: call.name,
                  tool_args: parseToolArguments(call.arguments),
                });

                const tool = toolById.get(call.name) ?? getTool(call.name);
                let content: string;
                if (!tool) {
                  content = `Error: unknown tool "${call.name}". Available tools: ${tools.map((t) => t.name).join(", ")}.`;
                } else {
                  const toolContext = makeToolContext(cycleTurn);
                  try {
                    const result = await tool.run(
                      parseToolArguments(call.arguments),
                      toolContext,
                    );
                    content = result.content;
                  } catch (err) {
                    logger.warning("tool execution failed", {
                      tool: call.name,
                      error: String(err),
                    });
                    content = `Error: tool "${call.name}" failed: ${String(err)}`;
                  }
                }
                inMemory.push({
                  role: "tool",
                  content,
                  tool_call_id: toolCallId,
                  name: call.name,
                });
              }
              continue; // next agent iteration with tool results appended
            }

            // ---- Final step: no tool calls -> emit the answer
            if (!stepBuffer.fullResponse().trim() && !runAbort.signal.aborted) {
              // Port of build_empty_llm_response_error (chat/errors.py).
              throw new LLMGenerationError("The model returned an empty response");
            }

            // AgentResponseStart (streaming_models.py): only final_documents
            // and pre_answer_processing_seconds — no id/content fields.
            emitter.sendObject("agent_response_start", cycleTurn, {
              final_documents: gatheredDocs.map(toSavedSearchDoc),
              pre_answer_processing_seconds:
                Math.round(((Date.now() - turnStartedAt) / 1000) * 100) / 100,
            });

            const processor = new DynamicCitationProcessor("HYPERLINK");
            processor.updateCitationMapping(citationMapping, true);
            for (const delta of stepBuffer.getDeltas()) {
              for (const item of processor.processToken(delta)) {
                if (typeof item === "string") {
                  if (item) emitter.send("agent_response_delta", cycleTurn, item);
                } else {
                  emitCitationInfo(emitter, item, cycleTurn);
                }
              }
            }
            for (const item of processor.processToken(null)) {
              if (typeof item === "string") {
                if (item) emitter.send("agent_response_delta", cycleTurn, item);
              } else {
                emitCitationInfo(emitter, item, cycleTurn);
              }
            }

            const answerText = stepBuffer.fullResponse();
            const citations: Citation[] = buildCitationsForAnswer(
              answerText,
              processor.getSeenCitations(),
            );
            // Citations persist as dict[citation_number -> document_id]
            // (db/models.py ChatMessage.citations JSONB dict semantics).
            const citationsMap: Record<string, string> = {};
            for (const c of citations) {
              citationsMap[String(c.citation_number)] = c.document_id;
            }

            // Persist the response + citations (chat/persistence.py).
            const saved = await appendChatMessage(session.id, answerText, "assistant");
            await updateChatMessage(saved.id, { citations: citationsMap });

            // Final line: bare ChatMessageDetail (server/query_and_chat/models.py)
            // — the frontend keys its tree/URL/citation state on it. The model
            // fields carry the RESOLVED model so the toolbar's per-message
            // model chip/selector works like cloud.
            push(
              JSON.stringify({
                chat_session_id: session.id,
                message_id: saved.id,
                message_type: "assistant",
                research_type: opts.deepResearch ? "deep_research" : null,
                parent_message: userMessage.id,
                latest_child_message: null,
                message: answerText,
                rephrased_query: null,
                context_docs: gatheredDocs.map(toSavedSearchDoc),
                time_sent: new Date().toISOString(),
                overridden_model: resolvedModelName ?? "",
                alternate_assistant_id: null,
                citations: citationsMap,
                files: [],
                tool_call: null,
                current_feedback: null,
                processing_duration_seconds:
                  Math.round(((Date.now() - turnStartedAt) / 1000) * 100) / 100,
                sub_questions: [],
                comments: null,
                parentMessageId: null,
                refined_answer_improvement: null,
                is_agentic: gatheredDocs.length > 0 || Boolean(opts.deepResearch),
                preferred_response_id: null,
                model_display_name: resolvedModelName ?? "",
                error: null,
              }) + "\n",
            );
            emitter.stop(0);
            return;
          }
          // Loop exhausted: the model kept calling tools until the cap.
          throw new ChatRuntimeError(
            `Agent exceeded the maximum of ${MAX_AGENT_STEPS} LLM cycles without a final answer`,
          );
        } catch (err) {
          // Error packet semantics (StreamingError + chat_error in persistence.py)
          const message =
            err instanceof Error ? err.message : String(err);
          const errorCode = err instanceof OnyxError ? err.code : null;
          const isRetryable = err instanceof LLMGenerationError;
          logger.error("chat turn failed", {
            error: message,
            code: errorCode,
            chat_session_id: opts.chatSessionId,
          });
          emitter.error(0, message, errorCode, isRetryable);
          // Persist the failure on an assistant row (mirrors error responses).
          try {
            const failed = await appendChatMessage(
              opts.chatSessionId,
              stepBuffer?.fullResponse() ?? "",
              "assistant",
            );
            await updateChatMessage(failed.id, { error: message });
          } catch (persistErr) {
            logger.warning("failed to persist chat error", {
              error: String(persistErr),
            });
          }
          emitter.stop(0);
        } finally {
          clearInterval(heartbeat);
        }
      };

      turn()
        .catch((err) => {
          logger.error("chat turn crashed", { error: String(err) });
        })
        .finally(() => {
          if (!closed) {
            try {
              // The legacy SSE surface terminates with `data: [DONE]`; the
              // v5.1.3 NDJSON protocol simply ends the body (the frontend's
              // reader stops on stream done).
              if (opts.wireFormat !== "ndjson") {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              }
            } catch {
              // client disconnected
            }
            closed = true;
            try {
              controller.close();
            } catch {
              // already closed
            }
          }
        });
    },
    cancel() {
      // Client disconnect aborts the agent loop (escape hatch).
      runAbort.abort();
    },
  });

  return stream;
}

function emitCitationInfo(
  emitter: StreamEmitter,
  info: CitationInfoEvent,
  turn: number,
): void {
  emitter.sendObject("citation_info", turn, {
    citation_number: info.citation_number,
    document_id: info.document_id,
  });
}
