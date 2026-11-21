/**
 * LLM reranking — TypeScript port of the reranking flows in
 * backend/onyx/tools/tool_implementations/search/search_tool.py
 *   (LLM relevance selection / decision-model rerank, L1468-1560) reduced to a
 * single scored-reorder step: the LLM sees the query and the candidate chunks
 * (numbered like Onyx's document prompt blocks) and returns a relevance score
 * 0-10 per document as JSON; docs are then reordered by score.
 *
 * Guarantees (mirroring the Python fallback semantics): any failure — provider
 * unavailability, malformed JSON, timeout — returns the original ranking
 * unchanged; reranking NEVER crashes the search flow.
 */
import type { SearchDoc } from "../types/domain";
import { getLLMProvider } from "../llm/factory";
import { getLogger } from "../utils/logger";

const logger = getLogger("search.rerank");

export interface RerankOptions {
  /** Trim the result to the first N docs after reranking. */
  topN?: number;
  /** Explicit opt-out; defaults to attempting rerank when called. */
  rerank?: boolean;
}

/** The numbered context block shown to the LLM (Onyx section_to_dict style). */
function formatDoc(doc: SearchDoc, num: number): string {
  const meta = Object.entries(doc.metadata)
    .slice(0, 5)
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
  const parts = [
    `[${num}]`,
    `Title: ${doc.semantic_identifier || doc.title}`,
    meta.length > 0 ? `Metadata: ${meta}` : null,
    doc.doc_updated_at ? `Updated: ${doc.doc_updated_at}` : null,
    `Content: ${doc.content.slice(0, 1200)}`,
  ].filter((p): p is string => p !== null);
  return parts.join("\n");
}

/** Extract the first JSON array from a possibly fenced LLM response. */
function parseScores(response: string, expected: number): number[] | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(response);
  const raw = fenced ? fenced[1] : response;
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const scores = new Array<number>(expected).fill(0);
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const obj = entry as { index?: unknown; score?: unknown };
    const idx = typeof obj.index === "number" ? Math.floor(obj.index) : NaN;
    const score = typeof obj.score === "number" ? obj.score : NaN;
    if (Number.isNaN(idx) || Number.isNaN(score)) continue;
    if (idx >= 1 && idx <= expected) {
      scores[idx - 1] = Math.max(0, Math.min(10, score));
    }
  }
  return scores;
}

export async function rerankDocs(
  query: string,
  docs: SearchDoc[],
  opts?: RerankOptions,
): Promise<SearchDoc[]> {
  const topN = opts?.topN;
  const applyTopN = (list: SearchDoc[]): SearchDoc[] =>
    topN !== undefined && topN >= 0 ? list.slice(0, topN) : list;

  if (opts?.rerank === false) return applyTopN(docs);
  if (docs.length <= 1) return applyTopN(docs);

  try {
    const llm = getLLMProvider();
    const numbered = docs
      .slice(0, 20)
      .map((doc, i) => formatDoc(doc, i + 1))
      .join("\n\n");
    const response = await llm.complete(
      [
        {
          role: "system",
          content:
            "You are a search relevance judge. Given a user query and numbered document " +
            "chunks, rate the relevance of each document to the query on a scale of 0 to 10 " +
            "(10 = directly answers the query, 0 = completely unrelated). Respond with ONLY " +
            "a JSON array of objects: [{\"index\": <document number>, \"score\": <0-10>}, ...] " +
            "covering every document.",
        },
        {
          role: "user",
          content: `Query: ${query}\n\nDocuments:\n${numbered}`,
        },
      ],
      { temperature: 0 },
    );
    const content = typeof response.content === "string" ? response.content : "";
    const scores = parseScores(content, Math.min(docs.length, 20));
    if (!scores) {
      logger.warning("rerank response was not parseable; keeping original order");
      return applyTopN(docs);
    }
    const rerankable = docs.slice(0, scores.length);
    const rest = docs.slice(scores.length);
    const reordered = rerankable
      .map((doc, i) => ({ doc, score: scores[i] ?? 0, original: i }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.original - b.original;
      })
      .map((entry) => entry.doc);
    return applyTopN([...reordered, ...rest]);
  } catch (err) {
    // Never crash search on rerank failure — fall back to the fused order.
    logger.warning("rerank failed; keeping original order", { error: String(err) });
    return applyTopN(docs);
  }
}
