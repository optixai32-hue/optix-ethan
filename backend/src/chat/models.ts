/**
 * Streaming packet model — TypeScript port of
 * backend/onyx/server/query_and_chat/streaming_models.py (StreamingType enum +
 * Packet envelope) and backend/onyx/chat/models.py (streaming-related models).
 *
 * The checked-out Python tree ships the newer `Packet { placement, obj }`
 * (discriminated-union) envelope; this port keeps the CLASSIC Onyx packet
 * envelope that the Onyx web frontend SSE parser historically consumed:
 *
 *     class Packet(BaseModel):
 *         seq: int       # sequence number of the packet within the stream
 *         packet: str    # JSON-serialized packet object (structured packets)
 *         ind: int       # index of the user message this packet belongs to
 *         type: str      # packet type (StreamingType value)
 *         message: str   # plain payload for simple (string) packets
 *
 * The type strings below mirror the StreamingType enum values verified in
 * backend/onyx/server/query_and_chat/streaming_models.py (lines 43-82), with
 * the classic "agent_response_start"/"agent_response_delta"/"final" names.
 */

export type PacketType =
  | "section_end"
  | "stop"
  | "error"
  | "chat_heartbeat"
  | "user_message"
  | "agent_response_start"
  | "agent_response_delta"
  | "final"
  | "citation_info"
  | "search_tool_start"
  | "search_tool_queries_delta"
  | "search_tool_filter_delta"
  | "search_tool_documents_delta"
  | "open_url_start"
  | "open_url_urls"
  | "open_url_documents"
  | "image_generation_start"
  | "image_generation_heartbeat"
  | "image_generation_final"
  | "tool_call_debug"
  | "tool_call_argument_delta"
  | "reasoning_start"
  | "reasoning_delta"
  | "reasoning_done"
  // Deep Research (streaming_models.py DeepResearchPlan/ResearchAgent packets;
  // consumed by web/src/app/app/message/messageComponents/timeline/packetHelpers.ts
  // and renderMessageComponent.tsx)
  | "deep_research_plan_start"
  | "deep_research_plan_delta"
  | "research_agent_start"
  | "intermediate_report_start"
  | "intermediate_report_delta"
  | "intermediate_report_cited_docs";

export interface Packet {
  /** Sequence number of the packet in the stream (1-based). */
  seq: number;
  /** JSON-serialized structured payload; empty string for simple packets. */
  packet: string;
  /** Index of the user message (turn) this packet belongs to. */
  ind: number;
  /** Packet type — a StreamingType value. */
  type: PacketType;
  /** Plain payload for simple packets (deltas, error text, final answer). */
  message: string;
  /** Parallel-tab index within the turn (upstream placement.tab_index
   * semantics: parallel tool calls share the turn with distinct tabs). */
  tab?: number;
  /** Nested sub-turn index within the (turn, tab) group (upstream
   * placement.sub_turn_index semantics). Deep Research research-agent steps
   * use it to nest their tool packets (searches) inside the agent step: the
   * frontend's ResearchAgentRenderer splits a group's packets by
   * sub_turn_index and renders each as a nested tool row. */
  subTurn?: number;
}

/** Citation metadata that travels with citation_info packets. */
export interface CitationInfoObj {
  citation_number: number;
  document_id: string;
}

/** Errors travel as an "error" packet (port of StreamingError semantics). */
export interface StreamingErrorObj {
  error: string;
  error_code: string | null;
  is_retryable: boolean;
}
