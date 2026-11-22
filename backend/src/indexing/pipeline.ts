/**
 * Indexing pipeline — TypeScript port of the Standard indexing flow:
 *   backend/onyx/indexing/indexing_pipeline.py
 *     (run_indexing_pipeline L1837, _embed_chunks_to_store L279,
 *      _upsert_documents_in_db L220, index_doc_batch L1549)
 *   backend/onyx/indexing/chunker.py (Chunker L124)
 *   backend/onyx/indexing/embedder.py (DefaultIndexingEmbedder.embed_chunks L123)
 *   backend/onyx/document_index/opensearch/opensearch_document_index.py
 *     (index/bulk write L526, delete_documents L693)
 *   backend/onyx/indexing/chunking/section_chunker.py (extract_blurb L12;
 *     blurb = first sentence, BLURB_SIZE=128 tokens -> capped at 256 chars here)
 *
 * Per document: chunk sections (links preserved in chunk metadata) -> embed
 * (batched at INDEXING_BATCH_SIZE) -> delete prior chunks (OpenSearch + DB,
 * reindex semantics) -> upsert document + chunk rows in one DB transaction
 * (RETURNING ids so the OpenSearch docs carry the real DB chunk ids, satisfying
 * the SearchDoc.chunk_id <-> chunk.id contract) -> bulk index to OpenSearch.
 * Index attempt rows are updated when an indexAttemptId is supplied.
 */
import type { ConnectorDoc } from "../types/domain.js";
import { query, withTransaction } from "../db/client.js";
import {
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
} from "../configs/constants.js";
import { chunkSectionsWithLinks } from "./chunker.js";
import { embedTexts } from "./embeddings.js";
import {
  bulkIndexChunks,
  deleteDocumentChunks,
  ensureDocumentIndex,
  type ChunkForIndex,
} from "./document_index/opensearch_index.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger("indexing.pipeline");

export interface IndexingResult {
  totalDocs: number;
  numSuccess: number;
  numFailed: number;
  errors: string[];
}

const MAX_REPORTED_ERRORS = 10;
const BLURB_MAX_CHARS = 256;

/** Port of extract_blurb: the first sentence of the chunk content. */
function extractBlurb(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length === 0) return "";
  const firstSentence = /^[\s\S]*?[.!?](?=\s|$)/.exec(trimmed)?.[0] ?? trimmed;
  const blurb = firstSentence.trim();
  return blurb.length > BLURB_MAX_CHARS ? `${blurb.slice(0, BLURB_MAX_CHARS - 1)}…` : blurb;
}

function ownerListFromMetadata(
  metadata: Record<string, string | number> | undefined,
  key: string,
): string[] {
  const raw = metadata?.[key];
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return [];
}

interface PreparedChunk {
  content: string;
  blurb: string;
  link?: string;
  embedding: number[];
}

/** Index one document end-to-end. Throws on failure; caller counts it. */
async function indexSingleDocument(doc: ConnectorDoc, sourceType: string): Promise<void> {
  await ensureDocumentIndex();

  // 1. Chunk (accumulator over sections, links preserved).
  const sectioned = chunkSectionsWithLinks(
    doc.sections.map((s) => ({ text: s.text ?? "", link: s.link })),
    { maxTokens: DEFAULT_CHUNK_SIZE, overlapTokens: DEFAULT_CHUNK_OVERLAP },
  );
  // Onyx appends an empty payload when a document has no content
  // (document_chunker.py: `payloads.append(ChunkPayload(text="", links={0: ""}))`).
  const emptyDoc = sectioned.length === 0;

  // 2. Embed (embedTexts batches at INDEXING_BATCH_SIZE internally).
  const texts = emptyDoc ? [""] : sectioned.map((c) => c.content);
  const embeddings = await embedTexts(texts);
  const prepared: PreparedChunk[] = texts.map((content, i) => ({
    content,
    blurb: extractBlurb(content),
    link: emptyDoc ? undefined : sectioned[i]?.link,
    embedding: embeddings[i] ?? [],
  }));

  // 3. Delete prior chunks from the document index (reindex semantics) —
  //    port of OpenSearchDocumentIndex.delete_documents.
  await deleteDocumentChunks([doc.id]);

  // 4. DB upsert in a single transaction (document row + chunk rows).
  const docMetadata = doc.metadata ?? {};
  const chunkIds = await withTransaction(async (client) => {
    await client.query("DELETE FROM chunk WHERE document_id = $1", [doc.id]);
    await client.query(
      `INSERT INTO document
         (id, title, source_type, semantic_identifier, doc_updated_at,
          primary_owners, secondary_owners, metadata, num_chunks, time_created)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, now())
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         source_type = EXCLUDED.source_type,
         semantic_identifier = EXCLUDED.semantic_identifier,
         doc_updated_at = EXCLUDED.doc_updated_at,
         primary_owners = EXCLUDED.primary_owners,
         secondary_owners = EXCLUDED.secondary_owners,
         metadata = EXCLUDED.metadata,
         num_chunks = EXCLUDED.num_chunks`,
      [
        doc.id,
        doc.title,
        sourceType,
        doc.title || doc.id,
        doc.doc_updated_at ?? null,
        ownerListFromMetadata(docMetadata, "primary_owners"),
        ownerListFromMetadata(docMetadata, "secondary_owners"),
        JSON.stringify(docMetadata),
        prepared.length,
      ],
    );
    const ids: number[] = [];
    for (let i = 0; i < prepared.length; i++) {
      const chunk = prepared[i];
      const chunkMetadata = { ...docMetadata, ...(chunk.link ? { link: chunk.link } : {}) };
      const res = await client.query<{ id: string }>(
        `INSERT INTO chunk (document_id, chunk_index, content, blurb, doc_updated_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         RETURNING id`,
        [doc.id, i, chunk.content, chunk.blurb, doc.doc_updated_at ?? null, JSON.stringify(chunkMetadata)],
      );
      ids.push(Number.parseInt(res.rows[0].id, 10));
    }
    return ids;
  });

  // 5. Bulk index to OpenSearch with the real DB chunk ids.
  const chunksForIndex: ChunkForIndex[] = prepared.map((chunk, i) => ({
    key: `${doc.id}_${i}`,
    document_id: doc.id,
    chunk_id: chunkIds[i],
    chunk_ind: i,
    title: doc.title,
    semantic_identifier: doc.title || doc.id,
    content: chunk.content,
    blurb: chunk.blurb,
    source_type: sourceType,
    doc_updated_at: doc.doc_updated_at ?? null,
    metadata: { ...docMetadata, ...(chunk.link ? { link: chunk.link } : {}) },
    primary_owners: ownerListFromMetadata(docMetadata, "primary_owners"),
    secondary_owners: ownerListFromMetadata(docMetadata, "secondary_owners"),
    embedding: chunk.embedding,
  }));
  await bulkIndexChunks(chunksForIndex);
  logger.debug("document indexed", {
    documentId: doc.id,
    chunks: chunksForIndex.length,
  });
}

async function updateIndexAttempt(
  indexAttemptId: number,
  result: IndexingResult,
): Promise<void> {
  const status =
    result.numFailed === 0 ? "completed" : result.numSuccess === 0 ? "failed" : "completed";
  const errorMsg =
    result.errors.length > 0 ? result.errors.join(" | ").slice(0, 2000) : null;
  try {
    await query(
      `UPDATE index_attempt
       SET status = $2, total_docs = $3, num_success = $4, num_failed = $5,
           error_msg = $6, time_updated = now()
       WHERE id = $1`,
      [indexAttemptId, status, result.totalDocs, result.numSuccess, result.numFailed, errorMsg],
    );
  } catch (err) {
    // Attempt bookkeeping must not mask the pipeline outcome.
    logger.error("failed to update index_attempt", {
      indexAttemptId,
      error: String(err),
    });
  }
}

/**
 * Port of run_indexing_pipeline: process a batch of connector documents into
 * chunks, embeddings, the document index, and the relational document/chunk
 * rows. Per-document failures are isolated; the result reports counts and the
 * first errors.
 */
export async function runIndexingPipeline(
  docs: ConnectorDoc[],
  sourceType: string,
  indexAttemptId?: number,
): Promise<IndexingResult> {
  const errors: string[] = [];
  let numSuccess = 0;

  for (const doc of docs) {
    try {
      await indexSingleDocument(doc, sourceType);
      numSuccess += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (errors.length < MAX_REPORTED_ERRORS) {
        errors.push(`${doc.id}: ${message}`);
      }
      logger.warning("document indexing failed", { documentId: doc.id, error: message });
    }
  }

  const result: IndexingResult = {
    totalDocs: docs.length,
    numSuccess,
    numFailed: docs.length - numSuccess,
    errors,
  };
  if (indexAttemptId !== undefined) {
    await updateIndexAttempt(indexAttemptId, result);
  }
  return result;
}
