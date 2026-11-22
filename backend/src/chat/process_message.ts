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
} from "../types/domain.js";
import { getLogger } from "../utils/logger.js";
import {
  ChatRuntimeError,
  InvalidMessageExceptionError,
  LLMGenerationError,
  OnyxError,
} from "../utils/errors.js";
import { getLLMProvider } from "../llm/factory.js";
import type { LLMMessage, LLMToolSpec } from "../llm/types.js";
import { StreamEmitter } from "./emitter.js";
import { runDeepResearch } from "./deep_research.js";
import { StreamBuffer } from "./stream_buffer.js";
import type { Packet } from "./models.js";
import {
  appendChatMessage,
  getChatMessages,
  getChatSession,
  updateChatMessage,
} from "./persistence.js";
import { buildHistory } from "./history_store.js";
import { getDefaultPersona, getPersona } from "../agents/personas.js";
import { buildCitedSystemPrompt } from "../rag/prompt_builder.js";
import {
  buildCitationsForAnswer,
  DynamicCitationProcessor,
} from "../rag/citations.js";
import type { CitationInfoEvent } from "../rag/citations.js";
import { getTool, listTools } from "../tools/registry.js";
import { registerBuiltInTools } from "../tools/built_in_tools.js";

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
  /** Per-turn provider routing from the send-chat-message llm_override
   * (model_configuration_id / model_provider resolution in
   * server/routes/chat.ts); takes precedence over the persona default. */
  llmProviderId?: string;
  /** Per-turn model name from the llm_override; falls back to the persona's
   * llm_model_version_override when unset. */
  llmModelName?: string;
  /** Deep Research toggle (web input bar): run the iterative multi-hop
   * research loop before the final answer (chat/deep_research.ts). */
  deepResearch?: boolean;
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
    tab_index: packet.tab ?? 0,
    sub_turn_index: null,
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
    case "reasoning_start":
      // ReasoningStart (streaming_models.py): thinking-phase opener — renders
      // as the collapsible "Thinking" timeline step (ReasoningRenderer).
      return (
        JSON.stringify({ placement, obj: { type: "reasoning_start" } }) + "\n"
      );
    case "reasoning_delta":
      return (
        JSON.stringify({
          placement,
          obj: { type: "reasoning_delta", reasoning: packet.message ?? "" },
        }) + "\n"
      );
    case "reasoning_done":
      return (
        JSON.stringify({ placement, obj: { type: "reasoning_done" } }) + "\n"
      );
    // ---- Deep Research packets (web/src/app/app/services/streamingModels.ts
    // DeepResearchPlan*/ResearchAgentStart/IntermediateReport* shapes)
    case "deep_research_plan_start":
      return (
        JSON.stringify({
          placement,
          obj: { type: "deep_research_plan_start" },
        }) + "\n"
      );
    case "deep_research_plan_delta":
      return (
        JSON.stringify({
          placement,
          obj: {
            type: "deep_research_plan_delta",
            content: packet.message || ((obj?.content as string | undefined) ?? ""),
          },
        }) + "\n"
      );
    case "research_agent_start":
      return (
        JSON.stringify({
          placement,
          obj: {
            type: "research_agent_start",
            research_task: (obj?.research_task as string | undefined) ?? packet.message ?? "",
          },
        }) + "\n"
      );
    case "intermediate_report_start":
      return (
        JSON.stringify({
          placement,
          obj: { type: "intermediate_report_start" },
        }) + "\n"
      );
    case "intermediate_report_delta":
      return (
        JSON.stringify({
          placement,
          obj: {
            type: "intermediate_report_delta",
            content: packet.message || ((obj?.content as string | undefined) ?? ""),
          },
        }) + "\n"
      );
    case "intermediate_report_cited_docs":
      return (
        JSON.stringify({
          placement,
          obj: {
            type: "intermediate_report_cited_docs",
            cited_docs: (obj?.cited_docs as unknown) ?? null,
          },
        }) + "\n"
      );
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

          const provider = await getLLMProvider(
            opts.llmProviderId ?? undefined,
            opts.llmModelName ?? persona.llm_model_version_override ?? undefined,
          );
          const tools = listTools();
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
          // called them) and `tab` the parallel tab within that turn (tab 0 is
          // reserved for the step's reasoning group, so each tool call renders
          // as its own parallel step).
          const makeToolContext = (turn: number, tab = 0) => ({
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
              emitter.sendRaw(packetType, turn, message, tab);
            },
          });

          // ---- Deep Research (chat toggle): plan -> search per sub-question
          // -> intermediate reports; the reports then seed the agent loop's
          // context so the final answer stays inside the normal cited path.
          if (opts.deepResearch) {
            const searchForResearch = async (query: string): Promise<SearchDoc[]> => {
              const searchToolInstance = toolById.get("search_internal") ?? getTool("search_internal");
              const webSearchInstance = toolById.get("web_search") ?? getTool("web_search");
              const docs: SearchDoc[] = [];
              for (const instance of [searchToolInstance, webSearchInstance]) {
                if (!instance || runAbort.signal.aborted) continue;
                try {
                  const result = await instance.run(
                    { query, num_hits: 10 },
                    makeToolContext(0),
                  );
                  // Tool.run returns formatted text; the documents themselves
                  // were already merged into gatheredDocs/citationMapping via
                  // the emit contract — read them from there.
                  void result;
                } catch (err) {
                  logger.warning("deep research tool failed", {
                    tool: instance.id,
                    error: String(err),
                  });
                }
              }
              // The tool context merged each tool's docs into gatheredDocs;
              // return the full gathered set (deduped by mergeGatheredDocs).
              docs.push(...gatheredDocs);
              return docs;
            };

            try {
              const research = await runDeepResearch({
                provider,
                emitter,
                query: opts.message,
                history: buildHistory(rows, persona.system_prompt),
                search: searchForResearch,
                mergeDocs: (incoming) =>
                  mergeGatheredDocs(gatheredDocs, citationMapping, incoming),
                signal: runAbort.signal,
              });
              // The reports become in-memory context ahead of the agent loop.
              inMemory.push(...research.contextMessages);
            } catch (err) {
              logger.warning("deep research loop failed", { error: String(err) });
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

            // Placement turn for this LLM cycle (llm_loop.py:1125 —
            // turn_index = llm_cycle_count; there is no forced retrieval step
            // in this port, so cycle 0 is the first LLM step and agent-loop
            // step N runs at turn N; tools called from this step share its
            // turn, each on its own parallel tab).
            const cycleTurn = step;

            stepBuffer = new StreamBuffer();
            let reasoningStarted = false;
            for await (const event of provider.stream(llmMessages, {
              ...(offerTools ? { tools: toolSpecs } : {}),
              signal: runAbort.signal,
            })) {
              if (event.reasoning) {
                // Reasoning tokens stream BEFORE the answer. They live in
                // their own packet group (the cycle's turn) so the frontend
                // renders the collapsible "Thinking" step; when the step is
                // the final one the answer is shifted one turn down to keep
                // the two groups disjoint (turn indices are ordered).
                if (!reasoningStarted) {
                  emitter.sendObject("reasoning_start", cycleTurn, {});
                  reasoningStarted = true;
                }
                emitter.send("reasoning_delta", cycleTurn, event.reasoning);
              }
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

            if (reasoningStarted) {
              emitter.sendObject("reasoning_done", cycleTurn, {});
            }

            const toolCalls = stepBuffer.getToolCalls().filter((c) => c.name);
            // The answer's placement turn: same cycle turn unless this step
            // streamed reasoning (that group owns cycleTurn — shift the answer
            // one turn down so both render as separate timeline steps).
            const answerTurn = reasoningStarted ? cycleTurn + 1 : cycleTurn;

            if (toolCalls.length > 0 && offerTools) {
              inMemory.push({
                role: "assistant",
                content: stepBuffer.fullResponse(),
                tool_calls: toolCalls,
              });
              let callIndex = 0;
              for (const call of toolCalls) {
                const toolCallId = call.id || `${call.name}-${callIndex}`;
                // Parallel-tab placement: each tool call of this cycle gets
                // its own tab so parallel tool steps render side by side
                // (tab 0 stays reserved for the step's reasoning group).
                const toolTab = callIndex + 1;
                callIndex += 1;
                emitter.sendObject("tool_call_debug", cycleTurn, {
                  tool_call_id: toolCallId,
                  tool_name: call.name,
                  tool_args: parseToolArguments(call.arguments),
                }, "", toolTab);

                const tool = toolById.get(call.name) ?? getTool(call.name);
                let content: string;
                if (!tool) {
                  content = `Error: unknown tool "${call.name}". Available tools: ${tools.map((t) => t.name).join(", ")}.`;
                } else {
                  const toolContext = makeToolContext(cycleTurn, toolTab);
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
            emitter.sendObject("agent_response_start", answerTurn, {
              final_documents: gatheredDocs.map(toSavedSearchDoc),
              pre_answer_processing_seconds:
                Math.round(((Date.now() - turnStartedAt) / 1000) * 100) / 100,
            });

            const processor = new DynamicCitationProcessor("HYPERLINK");
            processor.updateCitationMapping(citationMapping, true);
            for (const delta of stepBuffer.getDeltas()) {
              for (const item of processor.processToken(delta)) {
                if (typeof item === "string") {
                  if (item) emitter.send("agent_response_delta", answerTurn, item);
                } else {
                  emitCitationInfo(emitter, item, answerTurn);
                }
              }
            }
            for (const item of processor.processToken(null)) {
              if (typeof item === "string") {
                if (item) emitter.send("agent_response_delta", answerTurn, item);
              } else {
                emitCitationInfo(emitter, item, answerTurn);
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
            // — the frontend keys its tree/URL/citation state on it.
            push(
              JSON.stringify({
                chat_session_id: session.id,
                message_id: saved.id,
                message_type: "assistant",
                research_type: null,
                parent_message: userMessage.id,
                latest_child_message: null,
                message: answerText,
                rephrased_query: null,
                context_docs: gatheredDocs.map(toSavedSearchDoc),
                time_sent: new Date().toISOString(),
                overridden_model: persona.llm_model_version_override ?? "",
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
                is_agentic: gatheredDocs.length > 0,
                preferred_response_id: null,
                model_display_name: persona.llm_model_version_override ?? "",
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
