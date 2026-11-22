import { SearchToolPacket } from "@/app/app/services/streamingModels";
import {
  MessageRenderer,
} from "@/app/app/message/messageComponents/types";

/**
 * InternalSearchToolRenderer - Renders internal document search tool execution steps
 *
 * PRODUCT DECISION: the "Searching internal documents" step is intentionally
 * not rendered. The retrieval happens silently on the backend (documents and
 * citations still flow into the answer), but the timeline shows every OTHER
 * step (web search, thinking, image generation, ...). Returning an empty
 * renderer output keeps the packet group allocated while displaying nothing,
 * in every RenderType mode (FULL / COMPACT / HIGHLIGHT / INLINE).
 *
 * RenderType modes (kept for contract reference):
 * - FULL: Shows 1 combined timeline step (queries + results together).
 *         Used when step is expanded in timeline.
 * - COMPACT: Shows only results (no queries). Header passed as `status` prop.
 *            Used when step is collapsed in timeline, still wrapped in StepContainer.
 * - HIGHLIGHT: Shows only results with header embedded directly in content.
 *              No StepContainer wrapper. Used for parallel streaming preview.
 * - INLINE: Phase-based (queries -> results) for collapsed streaming view.
 */
export const InternalSearchToolRenderer: MessageRenderer<
  SearchToolPacket,
  {}
> = ({ children }) => {
  return children([]);
};
