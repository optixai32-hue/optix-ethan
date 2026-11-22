/**
 * Internal search tool — TypeScript port of
 * backend/onyx/tools/tool_implementations/search/search_tool.py (SearchTool:
 * NAME=internal_search, DISPLAY_NAME="Internal Search",
 * DESCRIPTION="Search connected applications for information.") and
 * backend/onyx/tools/tool_implementations/utils.py ::
 * convert_inference_sections_to_llm_string (per-document citation numbering +
 * the LLM-facing result fields).
 *
 * The ported tool delegates retrieval to the cross-module search pipeline
 * (`searchDocuments`, Task 2-c's src/search/orchestration.ts — the entrypoint
 * of onyx/context/search/pipeline.py :: search_pipeline) instead of the
 * multi-stage query-expansion/RRF/expansion loop, then formats results with
 * [n] markers + blurbs for the LLM, numbering each unique document_id once
 * (convert_inference_sections_to_llm_string's grouping rule).
 *
 * Gathered SearchDocs are delivered to the chat engine through
 * ToolContext.emit as a search_tool_documents_delta packet carrying the JSON
 * documents list — the same packet type streaming_models.py uses for live
 * search results — so the agent can build its citation mapping.
 */

import type { Tool, ToolContext, ToolResponse } from "../interface.js";
import { searchDocuments } from "../../search/orchestration.js";
import type { SearchRequest } from "../../search/orchestration.js";
import type { SearchDoc } from "../../types/domain.js";
import { getLogger } from "../../utils/logger.js";

const logger = getLogger("tools.search");

export const SEARCH_TOOL_ID = "search_internal";
/** Python: onyx/tools/constants.py INTERNAL_SEARCH_TOOL_NAME = "internal_search". */
export const INTERNAL_SEARCH_TOOL_NAME = "internal_search";

const SEARCH_TOOL_DESCRIPTION =
  "Search connected applications for information. Use for any question that may be answered by the user's documents, tickets, chats, or indexed files.";

/** Format SearchDocs with [n] markers + blurbs for the LLM (see header). */
export function formatSearchDocsForLlm(docs: SearchDoc[]): string {
  const lines: string[] = [
    "Search Results (cite results inline using the [n] markers):",
  ];
  const docIdToNumber = new Map<string, number>();
  let next = 1;
  for (const doc of docs) {
    let num = docIdToNumber.get(doc.document_id);
    if (num === undefined) {
      num = next;
      docIdToNumber.set(doc.document_id, num);
      next += 1;
    }
    lines.push(
      `[${num}] Title: ${doc.semantic_identifier} (source_type: ${doc.source_type})` +
        (doc.doc_updated_at ? ` (updated_at: ${doc.doc_updated_at})` : "") +
        `\nBlurb: ${doc.blurb}` +
        (doc.link ? `\nLink: ${doc.link}` : "") +
        `\nContent: ${doc.content}`,
    );
  }
  if (docs.length === 0) {
    lines.push("No results found. Answer from your own knowledge and say the internal search found nothing.");
  }
  return lines.join("\n\n");
}

export const searchTool: Tool = {
  id: SEARCH_TOOL_ID,
  name: SEARCH_TOOL_ID,
  displayName: "Internal Search",
  description: SEARCH_TOOL_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query. Break compound questions into separate targeted queries.",
      },
      num_hits: {
        type: "integer",
        description: "Maximum number of documents to return (default 10).",
        minimum: 1,
        maximum: 50,
      },
    },
    required: ["query"],
  },

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResponse> {
    const query = typeof input.query === "string" ? input.query : "";
    if (!query.trim()) {
      return { content: "Error: the 'query' argument is required." };
    }
    const numHits =
      typeof input.num_hits === "number" && Number.isFinite(input.num_hits)
        ? Math.trunc(input.num_hits)
        : undefined;

    const request: SearchRequest = {
      query,
      ...(numHits !== undefined ? { numHits } : {}),
    };
    let docs: SearchDoc[] = [];
    try {
      docs = await searchDocuments(request);
    } catch (err) {
      logger.warning("internal search failed", { error: String(err), query });
      return { content: `Internal search failed: ${String(err)}` };
    }

    // Emit the original 3-packet sequence (search_tool.py):
    //   SearchToolStart -> SearchToolQueriesDelta -> SearchToolDocumentsDelta.
    try {
      ctx.emit?.(
        "search_tool_start",
        JSON.stringify({ is_internet_search: false }),
      );
      ctx.emit?.(
        "search_tool_queries_delta",
        JSON.stringify({ queries: [query] }),
      );
      ctx.emit?.(
        "search_tool_documents_delta",
        JSON.stringify({ documents: docs }),
      );
    } catch (err) {
      logger.debug("search tool emit failed", { error: String(err) });
    }

    return { content: formatSearchDocsForLlm(docs) };
  },
};
