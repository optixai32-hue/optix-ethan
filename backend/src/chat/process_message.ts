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
 *        result is appended as an LLMMessage role 'tool' with tool_call_id.
 *        Answer content streams LIVE (llm_step.py semantics): AgentResponseStart
 *        is emitted lazily on the first content chunk and every chunk flows
 *        through the citation processor immediately, emitting
 *        agent_response_delta + citation_info packets as they arrive; only
 *        tool-call fragments are held back until the stream completes.
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
import { getLLMProvider } from "../llm/factory";
import type { LLMMessage, LLMToolSpec } from "../llm/types";
import { StreamEmitter } from "./emitter";
import { runDeepResearch } from "./deep_research";
import { StreamBuffer } from "./stream_buffer";
import type { Packet } from "./models";
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
import type { Tool } from "../tools/interface";

const logger = getLogger("chat.process_message");

/**
 * Tool-routing guidance appended to the persona system prompt whenever tools
 * are offered to the model (agent.py passes tools via the provider's tool
 * specs; the original deployment additionally relies on the WebSearchTool's
 * description to steer public-vs-internal routing). Free-tier models routinely
 * ignored the web_search tool and answered purely from internal search, so the
 * port states the routing contract explicitly: internal content -> internal
 * search, public/current knowledge -> web search, and internal search MUST
 * escalate to web search when it yields nothing relevant.
 */
const TOOL_ROUTING_GUIDANCE = `

# Tool Usage
You have access to tools that retrieve real information — use them instead of guessing.
- internal_search: searches ONLY the user's private/internal documents. Use it when the question may be answered by the user's own files, tickets, chats, or indexed internal content.
- web_search: searches the public web. Use it for current events, news, public facts, prices, product versions, or ANY question the user's internal documents cannot answer.
Routing rules:
1. If the question concerns the user's internal/private content, call internal_search.
2. If the question concerns public knowledge, current events, or anything time-sensitive, call web_search.
3. If internal_search returns no relevant results, call web_search before answering.
4. When in doubt, use both tools.`;

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
 *
 * Exported for the history replay: assistant messages persist their raw packet
 * list and GET /chat/chat-session/:id re-runs this builder so a reloaded
 * session renders the exact timeline the live stream produced.
 */
export function packetToFrameJson(packet: Packet): string | null {
  const placement = {
    turn_index: packet.ind ?? 0,
    tab_index: packet.tab ?? 0,
    // Nested sub-turn placement (upstream sub_turn_index): deep research
    // research-agent steps nest their search tool packets by sub_turn_index —
    // the frontend's ResearchAgentRenderer renders each as a nested tool row.
    sub_turn_index: packet.subTurn ?? null,
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
      return null;
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
        })
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
        })
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
        })
      );
    case "stop":
      return (
        JSON.stringify({
          placement,
          obj: { type: "stop", stop_reason: obj?.stop_reason ?? null },
        })
      );
    case "chat_heartbeat":
      return JSON.stringify({ placement, obj: { type: "chat_heartbeat" } });
    case "reasoning_start":
      // ReasoningStart (streaming_models.py): thinking-phase opener — renders
      // as the collapsible "Thinking" timeline step (ReasoningRenderer).
      return (
        JSON.stringify({ placement, obj: { type: "reasoning_start" } })
      );
    case "reasoning_delta":
      return (
        JSON.stringify({
          placement,
          obj: { type: "reasoning_delta", reasoning: packet.message ?? "" },
        })
      );
    case "reasoning_done":
      return (
        JSON.stringify({ placement, obj: { type: "reasoning_done" } })
      );
    // ---- Deep Research packets (web/src/app/app/services/streamingModels.ts
    // DeepResearchPlan*/ResearchAgentStart/IntermediateReport* shapes)
    case "deep_research_plan_start":
      return (
        JSON.stringify({
          placement,
          obj: { type: "deep_research_plan_start" },
        })
      );
    case "deep_research_plan_delta":
      return (
        JSON.stringify({
          placement,
          obj: {
            type: "deep_research_plan_delta",
            content: packet.message || ((obj?.content as string | undefined) ?? ""),
          },
        })
      );
    case "research_agent_start":
      return (
        JSON.stringify({
          placement,
          obj: {
            type: "research_agent_start",
            research_task: (obj?.research_task as string | undefined) ?? packet.message ?? "",
          },
        })
      );
    case "intermediate_report_start":
      return (
        JSON.stringify({
          placement,
          obj: { type: "intermediate_report_start" },
        })
      );
    case "intermediate_report_delta":
      return (
        JSON.stringify({
          placement,
          obj: {
            type: "intermediate_report_delta",
            content: packet.message || ((obj?.content as string | undefined) ?? ""),
          },
        })
      );
    case "intermediate_report_cited_docs":
      return (
        JSON.stringify({
          placement,
          obj: {
            type: "intermediate_report_cited_docs",
            cited_docs: (obj?.cited_docs as unknown) ?? null,
          },
        })
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
        })
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
      return JSON.stringify({ placement, obj: { ...payload, type: packet.type } });
    }
  }
}

/** NDJSON stream line for one packet (null packet types emit no line). */
function ndjsonFrame(packet: Packet): string {
  const json = packetToFrameJson(packet);
  return json === null ? "" : json + "\n";
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
          // `turn`/`tab` are the packet placement (turn_index/tab_index): the
          // frontend groups packets by (turn, tab) and renders each group as
          // one timeline step. Tools that own their own timeline row (the web
          // search step) run on a dedicated sequential turn; every other tool
          // keeps the upstream parallel-tab placement (llm_loop.py: tool
          // packets carry the turn of the LLM step that called them, each on
          // its own tab — tab 0 stays reserved for the reasoning group).
          // `subTurn` additionally nests the packets INSIDE a (turn, tab)
          // group (upstream sub_turn_index) — used by the deep research
          // research-agent steps, where the searches render as nested tool
          // rows of the agent step instead of separate timeline steps.
          // `onDocs` observes every SearchDoc payload a tool delivers (used by
          // the deep research searches to collect their per-round results).
          const makeToolContext = (
            turn: number,
            tab = 0,
            subTurn?: number,
            onDocs?: (docs: SearchDoc[]) => void,
          ) => ({
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
                    const docs = (parsed as { documents: SearchDoc[] }).documents;
                    mergeGatheredDocs(
                      gatheredDocs,
                      citationMapping,
                      docs,
                    );
                    if (onDocs) onDocs(docs);
                  }
                } catch {
                  // ignore malformed doc payloads
                }
              }
              // Forward tool progress to the user stream as a packet.
              emitter.sendRaw(packetType, turn, message, tab, subTurn);
            },
          });

          // ---- Deep Research (chat toggle): plan -> one research-agent
          // step per sub-question (searches nested inside + intermediate
          // report) -> the reports seed the agent loop's context so the final
          // answer stays inside the normal cited path.
          //
          // Timeline-turn budget: turn 0 = plan step, turns 1..N = research
          // agent steps. The agent loop continues on the NEXT fresh turn, so
          // the full timeline reads:
          //   Plan -> Research Agent 1 -> ... -> Research Agent N
          //        -> Thinking -> [Web Search] -> answer -> Done
          let nextTurn = 0;
          if (opts.deepResearch) {
            const searchForResearch = async (
              query: string,
              agentTurn: number,
            ): Promise<SearchDoc[]> => {
              const internalSearch =
                toolById.get("search_internal") ?? getTool("search_internal");
              const webSearch =
                toolById.get("web_search") ?? getTool("web_search");
              // The two searches are NESTED tool rows inside the research
              // agent step (sub_turn_index 1 = internal, 2 = web), matching
              // the original Deep Research agent layout — NOT separate
              // timeline steps and NOT status lines inside the report.
              const runs: Array<{ tool: Tool | undefined; subTurn: number }> = [
                { tool: internalSearch, subTurn: 1 },
                { tool: webSearch, subTurn: 2 },
              ];
              const docs: SearchDoc[] = [];
              for (const { tool, subTurn } of runs) {
                if (!tool || runAbort.signal.aborted) continue;
                try {
                  await tool.run(
                    { query, num_hits: 10, num: 10 },
                    makeToolContext(agentTurn, 0, subTurn, (d) =>
                      docs.push(...d),
                    ),
                  );
                } catch (err) {
                  logger.warning("deep research tool failed", {
                    tool: tool.id,
                    error: String(err),
                  });
                }
              }
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
                startTurn: 0,
                signal: runAbort.signal,
              });
              // The reports become in-memory context ahead of the agent loop.
              inMemory.push(...research.contextMessages);
              // The agent loop continues on a FRESH turn after the research
              // phases; the frontend closes the research steps (SECTION_END
              // injection) as soon as the first packet of this new turn lands.
              nextTurn = research.nextTurn;
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
          // Monotonic timeline-turn allocator: each LLM cycle takes the next
          // fresh turn; tools that own their own timeline row (the web search
          // step) consume a dedicated sequential turn. Deep research consumes
          // the turns before the loop (plan + one per research agent). Keeps
          // the timeline order collision free.
          for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
            if (runAbort.signal.aborted) {
              throw new ChatRuntimeError("Chat turn was aborted");
            }
            if (Date.now() - turnStartedAt > MAX_TURN_MS) {
              throw new ChatRuntimeError("Chat turn exceeded its time limit");
            }

            // Last iteration: no tools offered (port of tool_choice=NONE on
            // the final step, agent.py _prepare_step).
            const offerTools = step < MAX_AGENT_STEPS - 1;
            // Tools are offered on every step except the last; the routing
            // guidance only ships when the model can actually call tools.
            const personaPrompt = offerTools
              ? persona.system_prompt + TOOL_ROUTING_GUIDANCE
              : persona.system_prompt;
            const systemPrompt = buildCitedSystemPrompt(
              personaPrompt,
              gatheredDocs,
            );
            const llmMessages: LLMMessage[] = [
              ...buildHistory(rows, systemPrompt),
              ...inMemory,
            ];

            // Placement turn for this LLM cycle. A monotonic allocator (not
            // `step`): tools that own their own timeline row (the web search
            // step) consume a dedicated sequential turn, so later cycles never
            // collide with them. The timeline then reads, for example:
            //   Thinking(turn 0) -> Web Search(turn 1) -> Thinking(turn 2)
            //   -> answer(turn 3) -> Done
            const cycleTurn = nextTurn;

            stepBuffer = new StreamBuffer();
            let reasoningStarted = false;
            let reasoningClosed = false;
            // Live answer streaming (port of llm_step.py run_step): the answer
            // group opens lazily on the FIRST content chunk, then every chunk
            // is pushed to the user immediately through the citation processor.
            // Only tool-call fragments are buffered until the stream completes.
            let answerStarted = false;
            let answerProcessor: DynamicCitationProcessor | null = null;
            // The answer's placement turn: same cycle turn unless this step
            // streamed reasoning (that group owns cycleTurn — shift the answer
            // one turn down so both render as separate timeline steps).
            // Reasoning deltas always precede content deltas on the wire, so
            // the shift is decided before the first answer chunk arrives.
            const answerTurn = () => (reasoningStarted ? cycleTurn + 1 : cycleTurn);
            // Port of _close_reasoning_if_active: reasoning_done precedes the
            // answer's first packet.
            const closeReasoningIfActive = (): void => {
              if (reasoningStarted && !reasoningClosed) {
                emitter.sendObject("reasoning_done", cycleTurn, {});
                reasoningClosed = true;
              }
            };
            const emitAnswerChunk = (chunk: string): void => {
              closeReasoningIfActive();
              if (!answerStarted) {
                // AgentResponseStart (streaming_models.py): only final_documents
                // and pre_answer_processing_seconds — no id/content fields.
                emitter.sendObject("agent_response_start", answerTurn(), {
                  final_documents: gatheredDocs.map(toSavedSearchDoc),
                  pre_answer_processing_seconds:
                    Math.round(((Date.now() - turnStartedAt) / 1000) * 100) / 100,
                });
                answerProcessor = new DynamicCitationProcessor("HYPERLINK");
                answerProcessor.updateCitationMapping(citationMapping, true);
                answerStarted = true;
              }
              const proc = answerProcessor as DynamicCitationProcessor;
              for (const item of proc.processToken(chunk)) {
                if (typeof item === "string") {
                  if (item) emitter.send("agent_response_delta", answerTurn(), item);
                } else {
                  emitCitationInfo(emitter, item, answerTurn());
                }
              }
            };
            for await (const event of provider.stream(llmMessages, {
              ...(offerTools ? { tools: toolSpecs } : {}),
              signal: runAbort.signal,
            })) {
              if (event.reasoning) {
                // Reasoning tokens stream BEFORE the answer. They live in
                // their own packet group (the cycle's turn) so the frontend
                // renders the collapsible "Thinking" step. Late reasoning
                // after the answer group opened is dropped: it would collide
                // with the answer's (turn, tab) group and corrupt the timeline.
                if (!reasoningStarted && !answerStarted) {
                  emitter.sendObject("reasoning_start", cycleTurn, {});
                  reasoningStarted = true;
                }
                if (reasoningStarted) {
                  emitter.send("reasoning_delta", cycleTurn, event.reasoning);
                }
              }
              if (event.delta) {
                stepBuffer.processToken(event.delta);
                // Stream to the user NOW (llm_step.py:_emit_content_chunk).
                emitAnswerChunk(event.delta);
              }
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

            if (toolCalls.length > 0 && offerTools) {
              inMemory.push({
                role: "assistant",
                content: stepBuffer.fullResponse(),
                tool_calls: toolCalls,
              });
              // Close the cycle's reasoning BEFORE the tools run: the
              // "Thinking" step completes (checkmark), then each tool renders
              // as its own step in sequence — Thinking -> Web Search ->
              // Thinking -> ... -> Done (port of _close_reasoning_if_active).
              closeReasoningIfActive();
              let callIndex = 0;
              // Tools that own their own timeline row (the web search step)
              // run on a dedicated SEQUENTIAL turn; every other tool keeps
              // the upstream parallel-tab placement within the cycle turn.
              let ownRowToolCount = 0;
              let parallelToolCount = 0;
              // Sequential-turn base for own-row tools: after the answer
              // group when one already opened (content streamed alongside
              // the tool calls), else right after the cycle turn.
              const ownRowBase = answerStarted ? answerTurn() + 1 : cycleTurn + 1;
              for (const call of toolCalls) {
                const toolCallId = call.id || `${call.name}-${callIndex}`;
                callIndex += 1;
                const tool = toolById.get(call.name) ?? getTool(call.name);
                let content: string;
                if (!tool) {
                  content = `Error: unknown tool "${call.name}". Available tools: ${tools.map((t) => t.name).join(", ")}.`;
                } else {
                  // NOTE (upstream fidelity): no pre-tool packet is emitted
                  // here. The tool's own opening packet (SearchToolStart
                  // etc.) must be the FIRST packet of its (turn, tab) group —
                  // the frontend classifies each timeline group by its first
                  // packet, and a non-protocol packet (e.g. a debug frame)
                  // before it would leave the group unclassified, hiding the
                  // step entirely.
                  // The web search opens its own packet group
                  // (SearchToolStart with is_internet_search=true), which the
                  // frontend renders as a separate "Searching the web" step
                  // BETWEEN the Thinking steps.
                  const isWebSearchCall = tool.id === "web_search";
                  const toolContext = isWebSearchCall
                    ? (() => {
                        ownRowToolCount += 1;
                        return makeToolContext(ownRowBase + ownRowToolCount - 1, 0);
                      })()
                    : (() => {
                        parallelToolCount += 1;
                        return makeToolContext(cycleTurn, parallelToolCount);
                      })();
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
              // Reserve the turns consumed by this cycle: the cycle turn
              // itself plus one sequential turn per own-row tool (web search).
              nextTurn = ownRowBase + ownRowToolCount;
              continue; // next agent iteration with tool results appended
            }

            closeReasoningIfActive();

            // ---- Final step: no tool calls -> flush the already-streamed answer
            if (!stepBuffer.fullResponse().trim() && !runAbort.signal.aborted) {
              // Port of build_empty_llm_response_error (chat/errors.py).
              throw new LLMGenerationError("The model returned an empty response");
            }

            // The answer streamed live above (llm_step.py semantics); only the
            // citation-processor tail flush remains. If the stream was aborted
            // before any content chunk, open the answer group now so the
            // frontend still renders an (empty) message bubble.
            if (!answerStarted) emitAnswerChunk("");
            // emitAnswerChunk guarantees the processor exists; the ?? branch
            // only satisfies the compiler (closures defeat its narrowing).
            const proc =
              answerProcessor ?? new DynamicCitationProcessor("HYPERLINK");
            for (const item of proc.processToken(null)) {
              if (typeof item === "string") {
                if (item) emitter.send("agent_response_delta", answerTurn(), item);
              } else {
                emitCitationInfo(emitter, item, answerTurn());
              }
            }

            const answerText = stepBuffer.fullResponse();
            const citations: Citation[] = buildCitationsForAnswer(
              answerText,
              proc.getSeenCitations(),
            );
            // Citations persist as dict[citation_number -> document_id]
            // (db/models.py ChatMessage.citations JSONB dict semantics).
            const citationsMap: Record<string, string> = {};
            for (const c of citations) {
              citationsMap[String(c.citation_number)] = c.document_id;
            }

            // Persist the response + citations (chat/persistence.py) + the raw
            // packet list so a reloaded session replays the exact timeline
            // (Thinking -> Web Search -> Thinking -> answer -> Done).
            const saved = await appendChatMessage(
              session.id,
              answerText,
              "assistant",
              emitter.getPackets(),
            );
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
              emitter.getPackets(),
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
