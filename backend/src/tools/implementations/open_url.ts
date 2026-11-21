/**
 * Open URL tool — TypeScript port of
 * backend/onyx/tools/tool_implementations/open_url.py (OpenURLTool:
 * OPEN_URL_TOOL_ID, NAME="open_url", fetches web page(s) and returns their
 * textual content so the model can read a specific page).
 *
 * The ported implementation fetches each requested URL with a browser-like
 * User-Agent, strips HTML to text (regex-based tag/whitespace cleanup — no
 * headless browser in this deployment), and returns the first N characters
 * per page. OpenURLDocuments packets mirror upstream's
 * OpenURLStart -> OpenURLURLs -> OpenURLDocuments emission.
 */

import type { Tool, ToolContext, ToolResponse } from "../interface";
import { getLogger } from "../../utils/logger";

const logger = getLogger("tools.open_url");

export const OPEN_URL_TOOL_ID = "open_url";

const MAX_URLS = 5;
/** Per-page text budget (chars) — keeps tool results inside context limits. */
const MAX_PAGE_CHARS = 12_000;
const FETCH_TIMEOUT_MS = 15_000;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Strip HTML down to readable text (tags out, entities decoded, blocks spaced). */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)>/gi, "\n")
    .replace(/<(br|hr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
}

export const openUrlTool: Tool = {
  id: OPEN_URL_TOOL_ID,
  name: OPEN_URL_TOOL_ID,
  displayName: "Open URL",
  inCodeToolId: "OpenURLTool",
  description:
    "Open one or more URLs and read their page content. Use when the user shares a link or you need the full text behind a search result.",
  inputSchema: {
    type: "object",
    properties: {
      urls: {
        type: "array",
        items: { type: "string" },
        description: "The URL(s) to open and read (max 5).",
        maxItems: MAX_URLS,
      },
    },
    required: ["urls"],
  },

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResponse> {
    const raw = input.urls;
    const urls = Array.isArray(raw)
      ? raw.filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u)).slice(0, MAX_URLS)
      : typeof raw === "string" && /^https?:\/\//i.test(raw)
        ? [raw]
        : [];
    if (urls.length === 0) {
      return { content: "Error: provide at least one valid http(s) URL in 'urls'." };
    }

    try {
      ctx.emit?.("open_url_start", JSON.stringify({}));
      ctx.emit?.("open_url_urls", JSON.stringify({ urls }));
    } catch {
      // streaming surface unavailable (e.g. dev tool-run endpoint)
    }

    const sections: string[] = [];
    const docs: Array<Record<string, unknown>> = [];
    let index = 0;
    for (const url of urls) {
      index += 1;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8" },
          redirect: "follow",
        });
        clearTimeout(timer);
        const contentType = res.headers.get("content-type") ?? "";
        const body = await res.text();
        const text =
          contentType.includes("html") || /^\s*</.test(body)
            ? htmlToText(body)
            : body.trim();
        const clipped = text.slice(0, MAX_PAGE_CHARS);
        sections.push(
          `[${index}] URL: ${url} (status ${res.status})\n${clipped || "(empty page)"}`,
        );
        docs.push({
          document_id: url,
          semantic_identifier: url,
          link: url,
          blurb: clipped.slice(0, 200),
          content: clipped.slice(0, 2000),
          source_type: "web",
          is_internet: true,
          score: 0,
          chunk_id: -(index + 1000),
          metadata: { host_name: new URL(url).hostname },
        });
      } catch (err) {
        logger.warning("open_url fetch failed", { url, error: String(err) });
        sections.push(`[${index}] URL: ${url}\nError: failed to fetch (${String(err)})`);
      }
    }

    try {
      ctx.emit?.("open_url_documents", JSON.stringify({ documents: docs }));
    } catch {
      // ignore
    }

    return { content: sections.join("\n\n") };
  },
};
