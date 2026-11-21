/**
 * Web search tool — TypeScript port of
 * backend/onyx/tools/tool_implementations/web_search/web_search_tool.py
 * (WebSearchTool: NAME=web_search, DISPLAY_NAME="Web Search",
 * DESCRIPTION="Search the web for information.") and
 * backend/onyx/tools/tool_implementations/web_search/utils.py
 * (filter_web_search_results_with_no_title_or_snippet +
 * truncate_search_result_content, TRUNCATED_CONTENT_SUFFIX "[...truncated]").
 *
 * Provider capability verified against z-ai-web-dev-sdk@0.0.18
 * dist/index.d.ts: `zai.functions.invoke("web_search", {query, num?,
 * recency_days?})` returns SearchFunctionResultItem[] with
 * {url, name, snippet, host_name, rank, date, favicon}. This replaces the
 * Python pluggable WebSearchProvider (providers.py / clients/).
 *
 * Graceful degradation: when the SDK configuration (.z-ai-config) is missing
 * or the call fails, the tool is still registered and returns a ToolResponse
 * noting unavailability (mirroring WebSearchTool.is_available's gating without
 * removing the tool from the registry).
 */

import { getZaiClient } from "../../llm/providers/zai";
import type { Tool, ToolContext, ToolResponse } from "../interface";
import type { SearchDoc } from "../../types/domain";
import { getLogger } from "../../utils/logger";

const logger = getLogger("tools.web_search");

export const WEB_SEARCH_TOOL_ID = "web_search";
/** Python: onyx/tools/constants.py WEB_SEARCH_TOOL_NAME = "web_search". */
export const WEB_SEARCH_TOOL_NAME = "web_search";

const WEB_SEARCH_DESCRIPTION =
  "Search the web for information. Use for current events, public knowledge, or anything not covered by internal documents.";

/** Port of MAX_CHARS_PER_URL / TRUNCATED_CONTENT_SUFFIX (web_search/utils.py). */
const MAX_CHARS_PER_RESULT = 15000;
const TRUNCATED_CONTENT_SUFFIX = " [...truncated]";

interface WebSearchResultItem {
  url: string;
  name: string;
  snippet: string;
  host_name: string;
  rank: number;
  date: string;
  favicon: string;
}

function truncateContent(content: string): string {
  if (content.length <= MAX_CHARS_PER_RESULT) return content;
  return content.slice(0, MAX_CHARS_PER_RESULT) + TRUNCATED_CONTENT_SUFFIX;
}

/** Port of filter_web_search_results_with_no_title_or_snippet. */
function filterEmptyResults(results: WebSearchResultItem[]): WebSearchResultItem[] {
  return results.filter((r) => r.name.trim().length > 0 || r.snippet.trim().length > 0);
}

export const webSearchTool: Tool = {
  id: WEB_SEARCH_TOOL_ID,
  name: WEB_SEARCH_TOOL_ID,
  displayName: "Web Search",
  /** Upstream in-code id (onyx/tools/constants.py WEB_SEARCH_TOOL_ID). */
  inCodeToolId: "WebSearchTool",
  description: WEB_SEARCH_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The web search query.",
      },
      num: {
        type: "integer",
        description: "Number of results to fetch (default 5).",
        minimum: 1,
        maximum: 20,
      },
      recency_days: {
        type: "integer",
        description: "Restrict results to the last N days.",
        minimum: 1,
      },
    },
    required: ["query"],
  },

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResponse> {
    const query = typeof input.query === "string" ? input.query : "";
    if (!query.trim()) {
      return { content: "Error: the 'query' argument is required." };
    }
    const num =
      typeof input.num === "number" && Number.isFinite(input.num)
        ? Math.min(Math.max(Math.trunc(input.num), 1), 20)
        : 5;
    const recencyDays =
      typeof input.recency_days === "number" && Number.isFinite(input.recency_days)
        ? Math.trunc(input.recency_days)
        : undefined;

    let results: WebSearchResultItem[];
    try {
      const zai = await getZaiClient();
      results = await zai.functions.invoke("web_search", {
        query,
        num,
        ...(recencyDays !== undefined ? { recency_days: recencyDays } : {}),
      });
    } catch (err) {
      // Graceful degradation: report unavailability instead of throwing, so
      // the agent loop continues (the registry keeps the tool listed).
      logger.warning("web search unavailable", { error: String(err), query });
      return {
        content:
          "Web search is currently unavailable (no web search provider configured or the provider call failed). " +
          "Answer from internal sources or your own knowledge instead.",
      };
    }

    const filtered = filterEmptyResults(results);

    // Deliver synthetic web SearchDocs for the chat engine's citation mapping
    // (source_type "web", document_id = url — mirrors how the Python web
    // search results become citeable SearchDocs).
    const docs: SearchDoc[] = filtered.map((r, i) => ({
      chunk_id: -(i + 1), // synthetic chunk ids; web results have no chunk rows
      document_id: r.url,
      chunk_ind: 0,
      semantic_identifier: r.name || r.host_name,
      title: r.name,
      blurb: r.snippet,
      content: r.snippet,
      source_type: "web",
      metadata: { host_name: r.host_name, date: r.date },
      primary_owners: [],
      secondary_owners: [],
      doc_updated_at: r.date || null,
      score: r.rank,
    }));
    try {
      ctx.emit?.(
        "search_tool_documents_delta",
        JSON.stringify({ tool: WEB_SEARCH_TOOL_ID, documents: docs }),
      );
    } catch (err) {
      logger.debug("web search emit failed", { error: String(err) });
    }

    const lines: string[] = [
      "Web Search Results (cite results inline using the [n] markers):",
    ];
    filtered.forEach((r, i) => {
      lines.push(
        `[${i + 1}] Title: ${r.name || r.host_name}\nURL: ${r.url}` +
          (r.date ? `\nDate: ${r.date}` : "") +
          `\nSnippet: ${truncateContent(r.snippet)}`,
      );
    });
    if (filtered.length === 0) {
      lines.push("No web results found.");
    }
    return { content: lines.join("\n\n") };
  },
};
