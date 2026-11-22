/**
 * Hybrid search orchestration — TypeScript port of the Standard retrieval flow:
 *   backend/onyx/context/search/retrieval/search_runner.py (search_chunks L89:
 *       parallel keyword + semantic retrieval, combine_retrieval_results L27)
 *   backend/onyx/tools/tool_implementations/search/search_utils.py
 *       (weighted_reciprocal_rank_fusion — unweighted here, see search/rrf.ts)
 *   backend/onyx/context/search/utils.py (get_query_embedding L160)
 *   backend/onyx/tools/tool_implementations/search/search_tool.py (rerank stage)
 *
 * Pipeline: ensure index -> embed query -> keyword + vector retrieval in
 * parallel -> RRF fusion -> optional LLM rerank -> post-fusion filter + cap.
 */
import type { SearchDoc } from "../types/domain.js";
import { DEFAULT_NUM_RETRIEVED_DOCS, RRF_K } from "../configs/constants.js";
import { ensureDocumentIndex, keywordSearch, vectorSearch } from "../indexing/document_index/opensearch_index.js";
import { embedTexts } from "../indexing/embeddings.js";
import { reciprocalRankFusion } from "./rrf.js";
import { rerankDocs } from "./rerank.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger("search.orchestration");

export interface SearchRequest {
  query: string;
  numHits?: number;
  personaId?: number | null;
  rerank?: boolean;
  filters?: { sourceType?: string; documentSet?: string };
}

/** Post-fusion belt-and-suspenders filter (also applied query-side). */
function matchesFilters(doc: SearchDoc, filters?: SearchRequest["filters"]): boolean {
  if (filters?.sourceType && doc.source_type !== filters.sourceType) return false;
  if (filters?.documentSet) {
    const docSet = doc.metadata["document_set"];
    if (typeof docSet !== "string" || docSet !== filters.documentSet) return false;
  }
  return true;
}

export async function searchDocuments(req: SearchRequest): Promise<SearchDoc[]> {
  const query = req.query.trim();
  if (query.length === 0) {
    throw new Error("Search query must not be empty");
  }
  const numHits = req.numHits ?? DEFAULT_NUM_RETRIEVED_DOCS;
  const filters = req.filters;
  if (req.personaId !== undefined && req.personaId !== null) {
    // Persona-scoping in full Onyx restricts the corpus via ACLs / document
    // sets; the mini-service retrieval layer has no per-persona corpus, so the
    // id is accepted for interface parity only.
    logger.debug("search with persona filter (no-op in retrieval)", { personaId: req.personaId });
  }

  // Serverless deployments may run without OpenSearch (documented deviation):
  // index bootstrap and embedding are best-effort, and both retrieval legs
  // already fail-open to empty sets below — chat answers without retrieval.
  try {
    await ensureDocumentIndex();
  } catch (err) {
    logger.warning("document index unavailable — retrieval degraded to empty", {
      error: String(err),
    });
  }
  let queryEmbedding: number[] | undefined;
  try {
    [queryEmbedding] = await embedTexts([query]);
  } catch (err) {
    logger.warning("embedding unavailable — vector retrieval skipped", { error: String(err) });
  }

  // Parallel keyword + semantic retrieval (search_runner.py run_queries).
  const [keywordResults, vectorResults] = await Promise.all([
    keywordSearch(query, filters, numHits).catch((err) => {
      logger.warning("keyword retrieval failed", { error: String(err) });
      return [] as SearchDoc[];
    }),
    queryEmbedding
      ? vectorSearch(queryEmbedding, filters, numHits).catch((err) => {
          logger.warning("vector retrieval failed", { error: String(err) });
          return [] as SearchDoc[];
        })
      : Promise.resolve([] as SearchDoc[]),
  ]);

  // RRF fusion (keyword first like Onyx's fusion inputs; vector ranking is
  // listed first so equal-score ties favor semantic hits).
  let fused = reciprocalRankFusion([vectorResults, keywordResults], RRF_K);
  fused = fused.filter((doc) => matchesFilters(doc, filters));

  if (req.rerank) {
    const reranked = await rerankDocs(query, fused, {
      topN: numHits,
      rerank: true,
    });
    return reranked.filter((doc) => matchesFilters(doc, filters));
  }
  return fused.slice(0, numHits);
}
