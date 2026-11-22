/**
 * OpenSearch document index — TypeScript port of
 * backend/onyx/document_index/opensearch/opensearch_document_index.py
 * (verify_and_create_index_if_necessary L419, index/bulk write L526,
 * delete_documents L693) and backend/onyx/document_index/opensearch/search.py
 * (get_keyword_search_query L681, _get_title_content_combined_keyword_search_query
 * L1023, get_semantic_search_query L767, _get_content_vector_similarity_search_query
 * L1008) and backend/onyx/document_index/opensearch/schema.py
 * (DocumentSchema.get_document_schema L434, _get_knn_vector_method L407).
 *
 * Field layout note: Standard keeps a single content vector per chunk
 * (`content_vector` in schema.py); this port names it `embedding` per the
 * mini-service contract. Tenant/ACL fields (public, access_control_list,
 * cc_pair_ids, tenant_id) are intentionally absent — the mini-service is
 * single-tenant with DB-level auth.
 */
import type { SearchDoc } from "../../types/domain.js";
import { INDEXING_EMBEDDING_DIM } from "../../configs/constants.js";
import {
  bulkIndex,
  countByQuery,
  createIndex,
  deleteByQuery,
  indexExists,
  opensearchRequest,
  refreshIndex,
  search,
  type BulkIndexAction,
} from "../../vector_db/client.js";
import { getLogger } from "../../utils/logger.js";

const logger = getLogger("indexing.opensearch_index");

/**
 * Port of backend/onyx/configs/app_configs.py:449 DOCUMENT_INDEX_NAME =
 * "danswer_index". The TypeScript constants module is frozen by contract, so
 * the canonical index name lives here (configurable via env for parity with
 * Onyx's per-search-settings index_name).
 */
export const DOCUMENT_INDEX_NAME =
  process.env.ONYX_DOCUMENT_INDEX_NAME?.trim() || "danswer_index";

// HNSW tunables — port of document_index/opensearch/constants.py
// (EF_CONSTRUCTION = 256, M = 32).
const EF_CONSTRUCTION = 256;
const HNSW_M = 32;

export interface ChunkForIndex {
  /** Deterministic OpenSearch doc key: `${document_id}_${chunk_ind}`. */
  key: string;
  document_id: string;
  /** DB chunk row id (bigserial), surfaced as SearchDoc.chunk_id. */
  chunk_id: number;
  chunk_ind: number;
  title: string;
  semantic_identifier: string;
  content: string;
  blurb: string;
  source_type: string;
  doc_updated_at: string | null;
  metadata: Record<string, string | number>;
  primary_owners: string[];
  secondary_owners: string[];
  embedding: number[];
}

let indexReadyPromise: Promise<void> | null = null;

/**
 * Idempotent index bootstrap — port of
 * OpenSearchDocumentIndex.verify_and_create_index_if_necessary (L419) without
 * the Redis lock / cluster settings / pipeline plumbing (single-process
 * mini-service; promise memoization plays the role of the shared lock).
 */
export async function ensureDocumentIndex(): Promise<void> {
  if (indexReadyPromise) return indexReadyPromise;
  indexReadyPromise = (async () => {
    const exists = await indexExists(DOCUMENT_INDEX_NAME);
    if (!exists) {
      await createIndex(
        DOCUMENT_INDEX_NAME,
        getDocumentMappings(),
        getDocumentSettings(),
      );
      logger.info("document index created", { index: DOCUMENT_INDEX_NAME });
    } else {
      // Mirror put_mapping (L840): applying the same mapping is a no-op,
      // adding new fields is allowed, type conflicts raise.
      await putMapping(getDocumentMappings());
    }
  })().catch((err) => {
    indexReadyPromise = null; // allow retry on next call
    throw err;
  });
  return indexReadyPromise;
}

/** Settings — schema.py get_index_settings_based_on_environment (index.knn=true). */
function getDocumentSettings(): Record<string, unknown> {
  return {
    index: {
      knn: true,
      number_of_shards: 1,
      number_of_replicas: 0,
    },
  };
}

/**
 * Mappings — port of DocumentSchema.get_document_schema (schema.py L434):
 * text fields analyzed, keyword fields for exact filtering, date with
 * ignore_malformed so arbitrary connector timestamps never fail indexing,
 * metadata as flat_object (OpenSearch >= 2.11, replaces the
 * metadata_list keyword indirection of the original schema), knn_vector with
 * lucene HNSW + cosinesimil exactly as _get_knn_vector_method (L407).
 */
function getDocumentMappings(): Record<string, unknown> {
  return {
    dynamic: "strict",
    properties: {
      title: { type: "text", index_options: "offsets" },
      content: { type: "text", index_options: "offsets" },
      blurb: { type: "text" },
      semantic_identifier: { type: "text" },
      source_type: { type: "keyword" },
      document_id: { type: "keyword" },
      chunk_id: { type: "long" },
      chunk_ind: { type: "long" },
      doc_updated_at: { type: "date", ignore_malformed: true },
      metadata: { type: "flat_object" },
      primary_owners: { type: "keyword" },
      secondary_owners: { type: "keyword" },
      embedding: {
        type: "knn_vector",
        dimension: INDEXING_EMBEDDING_DIM,
        method: {
          name: "hnsw",
          space_type: "cosinesimil",
          engine: "lucene",
          parameters: {
            ef_construction: EF_CONSTRUCTION,
            m: HNSW_M,
          },
        },
      },
    },
  };
}

async function putMapping(mappings: Record<string, unknown>): Promise<void> {
  await opensearchRequest(`/${DOCUMENT_INDEX_NAME}/_mapping`, "PUT", mappings);
}

export interface SearchFilters {
  sourceType?: string;
  documentSet?: string;
}

/** keyword field term/terms clauses — port of _get_search_filters (search.py L1089). */
function buildFilterClauses(filters?: SearchFilters): Record<string, unknown>[] {
  const clauses: Record<string, unknown>[] = [];
  if (filters?.sourceType) {
    clauses.push({ term: { source_type: filters.sourceType } });
  }
  if (filters?.documentSet) {
    clauses.push({ term: { "metadata.document_set": filters.documentSet } });
  }
  return clauses;
}

/** _source excludes vectors — port of the `_source.excludes` in search.py. */
function sourceExcludes(): Record<string, unknown> {
  return { excludes: ["embedding"] };
}

/**
 * Keyword retrieval — port of get_keyword_search_query +
 * _get_title_content_combined_keyword_search_query (search.py L681, L1023):
 * bool/should over content match (1.0), content phrase (1.5 slop 1),
 * title match (0.1), title phrase (0.2 slop 1), blurb match (0.3); falls back
 * to a lenient simple_query_string when the structured match errors.
 */
export async function keywordSearch(
  query: string,
  filters: SearchFilters | undefined,
  size: number,
): Promise<SearchDoc[]> {
  const filterClauses = buildFilterClauses(filters);
  const body: Record<string, unknown> = {
    query: {
      bool: {
        should: [
          { match: { content: { query, operator: "or", boost: 1.0 } } },
          { match_phrase: { content: { query, slop: 1, boost: 1.5 } } },
          { match: { title: { query, operator: "or", boost: 0.1 } } },
          { match_phrase: { title: { query, slop: 1, boost: 0.2 } } },
          { match: { blurb: { query, operator: "or", boost: 0.3 } } },
        ],
        minimum_should_match: 1,
        ...(filterClauses.length > 0 ? { filter: filterClauses } : {}),
      },
    },
    size,
    _source: sourceExcludes(),
  };

  let hits;
  try {
    hits = await search(DOCUMENT_INDEX_NAME, body);
  } catch (err) {
    logger.warning("keyword match query failed, using query_string fallback", {
      error: String(err),
    });
    hits = await search(DOCUMENT_INDEX_NAME, {
      query: {
        bool: {
          must: [
            {
              simple_query_string: {
                query,
                fields: ["content^1.0", "title^0.2", "blurb^0.3"],
                default_operator: "or",
              },
            },
            ...(filterClauses.length > 0
              ? [{ bool: { filter: filterClauses } }]
              : []),
          ],
        },
      },
      size,
      _source: sourceExcludes(),
    });
  }
  return hits.map(hitToSearchDoc);
}

/**
 * Semantic retrieval — port of get_semantic_search_query +
 * _get_content_vector_similarity_search_query (search.py L767, L1008): a knn
 * query with `k` candidates and an optional boolean filter context.
 */
export async function vectorSearch(
  embedding: number[],
  filters: SearchFilters | undefined,
  size: number,
): Promise<SearchDoc[]> {
  const filterClauses = buildFilterClauses(filters);
  const knnFieldQuery: Record<string, unknown> = {
    vector: embedding,
    k: size,
  };
  if (filterClauses.length > 0) {
    knnFieldQuery["filter"] = { bool: { filter: filterClauses } };
  }
  const hits = await search(DOCUMENT_INDEX_NAME, {
    query: { knn: { embedding: knnFieldQuery } },
    size,
    _source: sourceExcludes(),
  });
  return hits.map(hitToSearchDoc);
}

/**
 * Convert a raw hit into the domain SearchDoc — port of
 * convert_retrieved_opensearch_chunk_to_inference_chunk_uncleaned
 * (opensearch_document_index.py L182), flattened into the SearchDoc shape.
 */
function hitToSearchDoc(hit: {
  id: string;
  score: number | null;
  source: Record<string, unknown>;
}): SearchDoc {
  const src = hit.source;
  const metadata: Record<string, string | number> =
    isPlainRecord(src["metadata"]) ? (src["metadata"] as Record<string, string | number>) : {};
  return {
    chunk_id: typeof src["chunk_id"] === "number" ? (src["chunk_id"] as number) : 0,
    document_id: String(src["document_id"] ?? ""),
    chunk_ind: typeof src["chunk_ind"] === "number" ? (src["chunk_ind"] as number) : 0,
    semantic_identifier: String(src["semantic_identifier"] ?? ""),
    title: String(src["title"] ?? ""),
    blurb: String(src["blurb"] ?? ""),
    content: String(src["content"] ?? ""),
    source_type: String(src["source_type"] ?? ""),
    metadata,
    primary_owners: asStringArray(src["primary_owners"]),
    secondary_owners: asStringArray(src["secondary_owners"]),
    doc_updated_at: typeof src["doc_updated_at"] === "string" ? (src["doc_updated_at"] as string) : null,
    score: hit.score,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v));
}

/**
 * Bulk write chunks — port of OpenSearchDocumentIndex.index (L526) reduced to
 * one bulk call (the per-group delete_by_query of the original is handled by
 * the pipeline's explicit reindex deletion).
 */
export async function bulkIndexChunks(chunks: ChunkForIndex[]): Promise<number> {
  if (chunks.length === 0) return 0;
  const actions: BulkIndexAction[] = chunks.map((chunk) => ({
    indexId: chunk.key,
    document: {
      title: chunk.title,
      content: chunk.content,
      blurb: chunk.blurb,
      semantic_identifier: chunk.semantic_identifier,
      source_type: chunk.source_type,
      document_id: chunk.document_id,
      chunk_id: chunk.chunk_id,
      chunk_ind: chunk.chunk_ind,
      doc_updated_at: chunk.doc_updated_at,
      metadata: chunk.metadata,
      primary_owners: chunk.primary_owners.length > 0 ? chunk.primary_owners : undefined,
      secondary_owners: chunk.secondary_owners.length > 0 ? chunk.secondary_owners : undefined,
      embedding: chunk.embedding,
    },
  }));
  const count = await bulkIndex(DOCUMENT_INDEX_NAME, actions);
  // Refresh synchronously so hybrid search immediately sees the new chunks
  // (Onyx issues a refresh at the end of the batch; same semantics).
  await refreshIndex(DOCUMENT_INDEX_NAME).catch((err) => {
    logger.warning("refresh after bulk index failed", { error: String(err) });
  });
  return count;
}

/** Delete all chunks of documents — port of delete_documents (L693). */
export async function deleteDocumentChunks(documentIds: string[]): Promise<number> {
  if (documentIds.length === 0) return 0;
  return deleteByQuery(DOCUMENT_INDEX_NAME, {
    terms: { document_id: documentIds },
  });
}

/** Count indexed chunks for a document (used by admin/status sanity checks). */
export async function countChunksForDocument(documentId: string): Promise<number> {
  return countByQuery(DOCUMENT_INDEX_NAME, {
    term: { document_id: documentId },
  });
}
