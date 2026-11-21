/**
 * Owned by Task 2-d. Port of backend/onyx/connectors/web/connector.py
 * (WebConnector) with a sandbox-appropriate fetch stack.
 *
 * Python source:
 *   - /home/z/onyx/backend/onyx/connectors/web/connector.py
 *     (WebConnector: base_url + web_connector_type in {"single","recursive","sitemap"};
 *      MAX_RETRIES=3 with exponential backoff; per-URL scrape failures are logged
 *      and skipped; doc id/link = the final URL; semantic id = page <title>;
 *      retrieve_all_slim_docs = load_from_state(slim=True); RuntimeError("No valid
 *      pages found.") when nothing was fetched; get_internal_links/_same_site for
 *      recursive same-site crawling; extract_urls_from_sitemap for sitemap mode)
 *   - /home/z/onyx/backend/onyx/file_processing/html_utils.py
 *     (web_html_cleanup: strip scripts/styles, extract <title> + cleaned text)
 *
 * Deviations (documented): Playwright/JS rendering is replaced by plain fetch()
 * with a 10s timeout (spec-mandated); BS4 is replaced by node-html-parser; SSRF
 * protected_url_check is reduced to an http/https scheme check (the sandbox has
 * no private-network boundary to defend); recursive crawls are bounded to 50
 * pages per run; sitemap mode parses <loc> entries without sitemap-index
 * expansion.
 */
import { parse } from "node-html-parser";
import type { ConnectorDoc, SlimDocMetadata } from "../../types/domain";
import type { ConnectorRunner } from "../framework";
import { loadState, saveState } from "../framework";
import { getLogger } from "../../utils/logger";

const logger = getLogger("connectors.web");

/** Port of WebConnector.MAX_RETRIES. */
const MAX_RETRIES = 3;
/** Per-request timeout (spec: 10s; Python uses REQUEST_TIMEOUT_SECONDS). */
const FETCH_TIMEOUT_MS = 10_000;
/** Bound for recursive crawls per run (sandbox safety; Python is unbounded). */
const RECURSIVE_MAX_PAGES = 50;

const WEB_TYPES = ["single", "recursive", "sitemap"] as const;
type WebType = (typeof WEB_TYPES)[number];

function ensureValidUrl(url: string): string {
  // Port of _ensure_valid_url: default the scheme to https.
  if (!url.includes("://")) return `https://${url}`;
  return url;
}

function isValidUrl(url: string): boolean {
  // Port of is_valid_url: needs scheme + host.
  try {
    const u = new URL(url);
    return Boolean(u.protocol) && Boolean(u.hostname);
  } catch {
    return false;
  }
}

function sameSite(baseUrl: string, candidate: string): boolean {
  // Port of _same_site: hostnames match (www. insensitive) and the candidate
  // path is under the base path.
  try {
    const base = new URL(baseUrl);
    const cand = new URL(candidate);
    const stripWww = (h: string) => h.toLowerCase().replace(/^www\./, "");
    if (stripWww(base.hostname) !== stripWww(cand.hostname)) return false;
    const basePath = (base.pathname || "/").replace(/\/+$/, "");
    if (basePath === "") return true;
    const candPath = cand.pathname || "/";
    if (candPath === basePath) return true;
    return candPath.startsWith(`${basePath}/`);
  } catch {
    return false;
  }
}

/**
 * Simplified port of web_html_cleanup (file_processing/html_utils.py): remove
 * script/style/noscript/template/svg nodes, read the <title>, and return
 * whitespace-normalized body text.
 */
function webHtmlCleanup(html: string): { title: string; cleanedText: string } {
  const root = parse(html);
  for (const tag of ["script", "style", "noscript", "template", "svg"]) {
    for (const node of root.querySelectorAll(tag)) {
      node.remove();
    }
  }
  const rawTitle = root.querySelector("title")?.text ?? "";
  const title = rawTitle.replace(/\s+/g, " ").trim();
  const body = root.querySelector("body") ?? root;
  const rawText = body.text.replace(/\u200b/g, "");
  const cleanedText = rawText
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
  return { title, cleanedText };
}

/** Absolute http(s) links found in an HTML fragment (port of get_internal_links). */
function extractLinks(html: string, sourceUrl: string): string[] {
  const root = parse(html);
  const links: string[] = [];
  for (const a of root.querySelectorAll("a")) {
    const href = a.getAttribute("href");
    if (!href) continue;
    const cleaned = href.replace(/\\/g, "/").split("#")[0];
    if (!cleaned) continue;
    let abs: string;
    try {
      abs = cleaned.includes("://") ? cleaned : new URL(cleaned, sourceUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(abs)) continue;
    links.push(abs);
  }
  return links;
}

interface FetchOutcome {
  finalUrl: string;
  html: string;
}

async function fetchHtml(url: string): Promise<FetchOutcome> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      "User-Agent": "onyx-ts-web-connector/0.1 (+https://onyx.engineering)",
      Accept: "text/html,application/xhtml+xml,application/xml",
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (
    contentType &&
    !contentType.includes("text/html") &&
    !contentType.includes("xml") &&
    !contentType.includes("text/plain")
  ) {
    throw new Error(`Unsupported content-type '${contentType}' for ${url}`);
  }
  return { finalUrl: response.url || url, html: await response.text() };
}

function extractSitemapUrls(xml: string, sourceUrl: string): string[] {
  // Port of extract_urls_from_sitemap: collect <loc> entries and make absolute.
  const root = parse(xml);
  const urls: string[] = [];
  for (const loc of root.querySelectorAll("loc")) {
    const raw = loc.text.trim();
    if (!raw) continue;
    try {
      const abs = raw.includes("://") ? raw : new URL(raw, sourceUrl).toString();
      if (isValidUrl(abs)) urls.push(abs);
    } catch {
      continue;
    }
  }
  return urls;
}

export class WebConnectorRunner implements ConnectorRunner {
  private readonly connectorId: number;
  private readonly baseUrl: string | null;
  private readonly webType: WebType;
  private readonly candidateUrls: string[];
  private docs: Map<string, ConnectorDoc> | null = null;

  constructor(
    connectorId: number,
    specificConfig: Record<string, unknown>,
    _credentials: Record<string, unknown>,
  ) {
    this.connectorId = connectorId;
    this.baseUrl = typeof specificConfig.base_url === "string" && specificConfig.base_url.length > 0
      ? ensureValidUrl(specificConfig.base_url)
      : null;
    this.webType = WEB_TYPES.includes(specificConfig.web_connector_type as WebType)
      ? (specificConfig.web_connector_type as WebType)
      : "single";
    const explicit = Array.isArray(specificConfig.urls)
      ? specificConfig.urls.filter(
          (u): u is string => typeof u === "string" && isValidUrl(ensureValidUrl(u)),
        )
      : [];
    if (explicit.length > 0) {
      this.candidateUrls = explicit.map(ensureValidUrl);
    } else if (this.baseUrl !== null) {
      // Port of __init__: single/recursive seed the to_visit_list with base_url.
      this.candidateUrls = this.webType === "sitemap" ? [] : [this.baseUrl];
    } else {
      throw new Error("Web connector config requires base_url or a non-empty urls list");
    }
  }

  private sitemapUrl(): string {
    const source = this.baseUrl ?? this.candidateUrls[0];
    if (!source) throw new Error("Sitemap connector requires base_url");
    return source;
  }

  /**
   * Fetch one page. Port of _do_scrape: doc id/link = final URL (after
   * redirects), semantic id/title = page <title> or the URL. Returns the doc
   * plus (recursive mode) the same-site links discovered on the page.
   */
  private async scrapeUrl(
    url: string,
    mode: "page" | "sitemap",
  ): Promise<{ doc: ConnectorDoc | null; links: string[] }> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        // Port of the exponential backoff between retries.
        const delayMs = Math.min(2 ** attempt * 1000, 10_000);
        logger.info(`retry ${attempt}/${MAX_RETRIES} for ${url} after ${delayMs}ms`, {
          connectorId: this.connectorId,
        });
        await new Promise((r) => setTimeout(r, delayMs));
      }
      try {
        if (!/^https?:\/\//i.test(url)) {
          throw new Error("URL must be of scheme https?://");
        }
        const { finalUrl, html } = await fetchHtml(url);

        if (mode === "sitemap") {
          // Port of extract_urls_from_sitemap: expand <loc> entries into targets.
          return { doc: null, links: extractSitemapUrls(html, finalUrl) };
        }

        const { title, cleanedText } = webHtmlCleanup(html);
        if (!cleanedText) {
          logger.warning("No readable text extracted; skipping page", {
            connectorId: this.connectorId,
            url,
          });
          return { doc: null, links: [] };
        }
        const doc: ConnectorDoc = {
          id: finalUrl, // port of storage_url: the absolute URL is the doc id
          title: title || finalUrl, // port of semantic_identifier
          sections: [{ text: cleanedText, link: finalUrl }], // port of TextSection(link, text)
          metadata: { link: finalUrl },
          // doc_updated_at intentionally unset — port of the Python comment:
          // Last-Modified is an unreliable change signal for web content.
        };
        const links = this.webType === "recursive" ? extractLinks(html, finalUrl) : [];
        return { doc, links };
      } catch (err) {
        lastError = err;
        logger.warning(`Failed to fetch '${url}': ${String(err)}`, {
          connectorId: this.connectorId,
          attempt: attempt + 1,
        });
      }
    }
    logger.warning(`Skipping '${url}' after ${MAX_RETRIES} attempts: ${String(lastError)}`, {
      connectorId: this.connectorId,
    });
    return { doc: null, links: [] };
  }

  /**
   * Fetch every target page. Port of load_from_state's visit loop:
   * pop URLs off the to-visit list, dedupe by visited set, and in recursive
   * mode append same-site internal links (bounded in the sandbox).
   */
  private async scrapeAll(): Promise<Map<string, ConnectorDoc>> {
    const docs = new Map<string, ConnectorDoc>();
    const visited = new Set<string>();
    let queue: string[] = [];

    if (this.webType === "sitemap") {
      const { links } = await this.scrapeUrl(this.sitemapUrl(), "sitemap");
      if (links.length === 0) {
        throw new Error(`No URLs found in sitemap ${this.sitemapUrl()}`);
      }
      queue = links;
    } else {
      queue = [...this.candidateUrls];
    }

    const baseForSameSite = this.baseUrl ?? this.candidateUrls[0] ?? null;
    let pages = 0;
    while (queue.length > 0) {
      const url = queue.pop(); // port of session_ctx.to_visit.pop()
      if (!url || visited.has(url)) continue;
      visited.add(url);
      if (this.webType === "recursive" && pages >= RECURSIVE_MAX_PAGES) {
        logger.warning("recursive crawl bound reached; remaining pages skipped", {
          connectorId: this.connectorId,
          bound: RECURSIVE_MAX_PAGES,
        });
        break;
      }
      pages += 1;
      const { doc, links } = await this.scrapeUrl(url, "page");
      if (doc === null) continue; // graceful per-URL failure (log + skip)
      docs.set(doc.id, doc);
      if (this.webType === "recursive" && baseForSameSite !== null) {
        for (const link of links) {
          if (!visited.has(link) && sameSite(baseForSameSite, link)) {
            queue.push(link);
          }
        }
      }
    }
    return docs;
  }

  private async ensureDocs(): Promise<Map<string, ConnectorDoc>> {
    if (this.docs !== null) return this.docs;
    const fetched = await this.scrapeAll();
    if (fetched.size === 0) {
      // Port of load_from_state: "No valid pages found." — surfaced to the
      // indexing task so the index attempt is marked failed.
      throw new Error("No valid pages found.");
    }
    const prior = await loadState(this.connectorId);
    const lastSyncAt = new Date().toISOString();
    await saveState(this.connectorId, {
      ...prior,
      docIds: [...fetched.keys()],
      lastSyncAt,
    });
    this.docs = fetched;
    return fetched;
  }

  /** Port of WebConnector.load_from_state: enumerate pages, cache docs, save state. */
  async load_from_state(): Promise<Record<string, unknown>> {
    const docs = await this.ensureDocs();
    return {
      docCount: docs.size,
      docIds: [...docs.keys()],
      baseUrl: this.baseUrl,
      webType: this.webType,
      lastSyncAt: new Date().toISOString(),
    };
  }

  /** Port of WebConnector.retrieve_all_slim_docs (load_from_state(slim=True)). */
  async retrieve_all_slim_docs(): Promise<SlimDocMetadata[]> {
    const docs = await this.ensureDocs();
    return [...docs.values()].map((d) => ({
      id: d.id,
      title: d.title,
      doc_updated_at: d.doc_updated_at,
    }));
  }

  /** Port of the checkpointed flow's fetch_docs(doc_ids): full content per id. */
  async fetch_docs(doc_ids: string[]): Promise<ConnectorDoc[]> {
    const docs = await this.ensureDocs();
    const wanted = new Set(doc_ids);
    return [...docs.values()].filter((d) => wanted.has(d.id));
  }
}
