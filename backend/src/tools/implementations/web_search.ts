/**
 * Web search tool — TypeScript port of
 * backend/onyx/tools/tool_implementations/web_search/web_search_tool.py
 * (WebSearchTool: NAME=web_search, DISPLAY_NAME="Web Search",
 * DESCRIPTION="Search the web for information.") and
 * backend/onyx/tools/tool_implementations/web_search/utils.py
 * (filter_web_search_results_with_no_title_or_snippet +
 * truncate_search_result_content, TRUNCATED_CONTENT_SUFFIX "[...truncated]").
 *
 * Single-provider deployment: the ONLY search surface is the Yonderly web
 * search endpoint — `GET https://search.yonderly.org/web?s=<query>` (a
 * 4get/SearX-style metasearch instance). There is no provider selection, no
 * credential configuration and no admin web-search setup: this endpoint is
 * the fixed backend. Results arrive as server-rendered HTML (the instance
 * does not expose format=json), so the tool scrapes the `text-result`
 * blocks: each result's `<a class="hover" href="...">` anchor wraps a
 * `.title` div and a `.description` div.
 *
 * The request MUST carry a browser User-Agent — the instance blocks
 * non-browser clients ("Tshh, blocked!") — so we send a stable Chrome UA.
 *
 * Graceful degradation: when the endpoint is unreachable or blocked, the
 * tool is still registered and returns a ToolResponse noting unavailability
 * (mirroring WebSearchTool.is_available's gating without removing the tool
 * from the registry).
 */

import type { Tool, ToolContext, ToolResponse } from "../interface";
import type { SearchDoc } from "../../types/domain";
import { getLogger } from "../../utils/logger";

const logger = getLogger("tools.web_search");

export const WEB_SEARCH_TOOL_ID = "web_search";
/** Python: onyx/tools/constants.py WEB_SEARCH_TOOL_NAME = "web_search". */
export const WEB_SEARCH_TOOL_NAME = "web_search";

const WEB_SEARCH_DESCRIPTION =
  "Search the public web for information. Use this for current events, news, public facts, prices, versions, documentation of public products, or ANY question that the user's internal documents cannot answer. If internal search returned no relevant results, call this tool before answering.";

/** The single fixed web-search surface (no configuration — see docblock). */
const YONDERLY_SEARCH_URL =
  process.env.YONDERLY_SEARCH_BASE_URL?.trim() ||
  "https://search.yonderly.org/web";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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

/** Strip tags + collapse whitespace + unescape entities (4get markup). */
function htmlToText(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) =>
      String.fromCodePoint(parseInt(code, 16)),
    )
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse the Yonderly (4get) results page. Each organic result is a
 * `<div class="text-result">` block whose `<a class="hover" href="...">`
 * anchor wraps `<div class="title">` + `<div class="description">`.
 * The initial "answer" spoiler block has no hover anchor and is skipped.
 */
function parseYonderlyResults(htmlBody: string, limit: number): WebSearchResultItem[] {
  // Blocked/anti-bot page: no results to scrape.
  if (htmlBody.includes("has been blocked from this")) return [];

  const results: WebSearchResultItem[] = [];
  const blocks = htmlBody.split('<div class="text-result">').slice(1);
  for (const block of blocks) {
    const anchor = block.match(/<a href="(https?:\/\/[^"]+)" class="hover"/);
    if (!anchor) continue;
    const url = anchor[1];
    const titleMatch = block.match(/<div class="title">([\s\S]*?)<\/div>/);
    const descMatch = block.match(/<div class="description">([\s\S]*?)<\/div>/);
    const name = titleMatch ? htmlToText(titleMatch[1]) : "";
    const snippet = descMatch ? htmlToText(descMatch[1]) : "";
    // Port of filter_web_search_results_with_no_title_or_snippet.
    if (!name.trim() && !snippet.trim()) continue;
    let hostName = "";
    try {
      hostName = new URL(url).hostname;
    } catch {
      hostName = "";
    }
    results.push({
      url,
      name,
      snippet,
      host_name: hostName,
      rank: results.length + 1,
      date: "",
      favicon: "",
    });
    if (results.length >= limit) break;
  }
  return results;
}

export const webSearchTool: Tool = {
  id: WEB_SEARCH_TOOL_ID,
  name: WEB_SEARCH_TOOL_ID,
  displayName: "Web Search",
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

    // Emit the original 3-packet sequence (search_tool.py, internet variant):
    //   SearchToolStart(is_internet_search=true) -> SearchToolQueriesDelta
    //   -> SearchToolDocumentsDelta — the frontend renders this as the
    //   "Searching the web" timeline step (WebSearchToolRenderer).
    try {
      ctx.emit?.(
        "search_tool_start",
        JSON.stringify({ is_internet_search: true }),
      );
      ctx.emit?.(
        "search_tool_queries_delta",
        JSON.stringify({ queries: [query] }),
      );
    } catch (err) {
      logger.debug("web search emit failed", { error: String(err) });
    }

    let results: WebSearchResultItem[];
    try {
      const response = await fetch(
        `${YONDERLY_SEARCH_URL}?s=${encodeURIComponent(query)}`,
        {
          headers: {
            "User-Agent": BROWSER_UA,
            Accept: "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
          },
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!response.ok) {
        throw new Error(`yonderly returned ${response.status}`);
      }
      results = parseYonderlyResults(await response.text(), num);
    } catch (err) {
      // Graceful degradation: report unavailability instead of throwing, so
      // the agent loop continues (the registry keeps the tool listed).
      logger.warning("web search unavailable", { error: String(err), query });
      return {
        content:
          "Web search is currently unavailable (the web search endpoint could not be reached or blocked this request). " +
          "Answer from internal sources or your own knowledge instead.",
      };
    }

    // Deliver synthetic web SearchDocs for the chat engine's citation mapping
    // (source_type "web", document_id = url — mirrors how the Python web
    // search results become citeable SearchDocs).
    const docs: SearchDoc[] = results.map((r, i) => ({
      chunk_id: -(i + 1), // synthetic chunk ids; web results have no chunk rows
      document_id: r.url,
      chunk_ind: 0,
      semantic_identifier: r.name || r.host_name,
      title: r.name,
      blurb: r.snippet,
      content: r.snippet,
      source_type: "web",
      // The result URL doubles as the document link: the frontend renders the
      // site's real favicon from this link (WebResultIcon/SourceTag) and the
      // cited context becomes a clickable [n](url) reference — mirroring how
      // the Python web connector populates OnyxDocument.link.
      link: r.url,
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
    results.forEach((r, i) => {
      lines.push(
        `[${i + 1}] Title: ${r.name || r.host_name}\nURL: ${r.url}` +
          (r.date ? `\nDate: ${r.date}` : "") +
          `\nSnippet: ${truncateContent(r.snippet)}`,
      );
    });
    if (results.length === 0) {
      lines.push("No web results found.");
    }
    return { content: lines.join("\n\n") };
  },
};
