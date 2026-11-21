/**
 * Document management routes — TypeScript port of the Onyx document APIs:
 *   backend/onyx/server/documents/ (document listing / detail endpoints)
 *   backend/onyx/server/api_paths or the ingestion upload path (POST
 *   upload-text runs runIndexingPipeline directly — the ad-hoc ingest flow of
 *   Onyx's "My Documents" upload)
 *   backend/onyx/document_index (delete-by-document flow)
 *
 * GET    /                  list documents from the DB document table (paginated)
 * GET    /:id               document detail + its chunk rows
 * POST   /upload-text       { title, text, source_type? } ad-hoc ingest
 * DELETE /:id               delete chunks (OpenSearch deleteByQuery + DB) + doc row
 */
import { Hono } from "hono";
import { z } from "zod";
import { query, queryOne } from "../../db/client";
import { runIndexingPipeline } from "../../indexing/pipeline";
import { deleteDocumentChunks, ensureDocumentIndex } from "../../indexing/document_index/opensearch_index";
import { InvalidRequestError, NotFoundError } from "../../utils/errors";
import { getLogger } from "../../utils/logger";
import { randomUUID } from "node:crypto";

const logger = getLogger("server.routes.documents");

export const documentsRoutes = new Hono();

const uploadTextSchema = z.object({
  title: z.string().min(1).max(512),
  text: z.string().min(1),
  source_type: z.string().min(1).optional(),
});

interface DocumentDbRow {
  id: string;
  title: string;
  source_type: string;
  semantic_identifier: string;
  doc_updated_at: string | null;
  primary_owners: string[];
  secondary_owners: string[];
  metadata: Record<string, string | number>;
  num_chunks: number;
  time_created: Date;
}

interface ChunkDbRow {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  blurb: string;
  doc_updated_at: string | null;
  metadata: Record<string, string | number>;
}

function serializeDocument(row: DocumentDbRow): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    source_type: row.source_type,
    semantic_identifier: row.semantic_identifier,
    doc_updated_at: row.doc_updated_at,
    primary_owners: row.primary_owners ?? [],
    secondary_owners: row.secondary_owners ?? [],
    metadata: row.metadata ?? {},
    num_chunks: Number(row.num_chunks ?? 0),
    time_created: row.time_created,
  };
}

// GET / — paginated document list, newest first
documentsRoutes.get("/", async (c) => {
  const pageRaw = Number.parseInt(c.req.query("page") ?? "1", 10);
  const limitRaw = Number.parseInt(c.req.query("limit") ?? "50", 10);
  // `page` is 1-based (matches the Onyx web pagination convention).
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 50;
  const offset = (page - 1) * limit;

  const totalRes = await query<{ count: string }>("SELECT count(*)::text AS count FROM document");
  const rows = await query<DocumentDbRow>(
    `SELECT id, title, source_type, semantic_identifier, doc_updated_at,
            primary_owners, secondary_owners, metadata, num_chunks, time_created
     FROM document
     ORDER BY time_created DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );

  return c.json({
    documents: rows.rows.map(serializeDocument),
    page,
    limit,
    total: Number.parseInt(totalRes.rows[0]?.count ?? "0", 10),
  });
});

// GET /:id — document + chunk rows
documentsRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const doc = await queryOne<DocumentDbRow>(
    `SELECT id, title, source_type, semantic_identifier, doc_updated_at,
            primary_owners, secondary_owners, metadata, num_chunks, time_created
     FROM document WHERE id = $1`,
    [id],
  );
  if (!doc) throw new NotFoundError("Document");

  const chunks = await query<ChunkDbRow>(
    `SELECT id, document_id, chunk_index, content, blurb, doc_updated_at, metadata
     FROM chunk WHERE document_id = $1 ORDER BY chunk_index ASC`,
    [id],
  );

  return c.json({
    document: serializeDocument(doc),
    chunks: chunks.rows.map((row) => ({
      id: Number(row.id),
      document_id: row.document_id,
      chunk_index: row.chunk_index,
      content: row.content,
      blurb: row.blurb,
      doc_updated_at: row.doc_updated_at,
      metadata: row.metadata ?? {},
    })),
  });
});

// POST /upload-text — ad-hoc ingest straight through the indexing pipeline
documentsRoutes.post("/upload-text", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = uploadTextSchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidRequestError(`Invalid upload request: ${parsed.error.message}`);
  }
  const { title, text, source_type } = parsed.data;
  const documentId = randomUUID();

  await ensureDocumentIndex();
  const result = await runIndexingPipeline(
    [{ id: documentId, title, sections: [{ text }] }],
    source_type ?? "ingest_document",
  );
  if (result.numFailed > 0) {
    logger.error("upload-text indexing failed", { documentId, errors: result.errors });
    throw new InvalidRequestError(`Failed to index document: ${result.errors[0] ?? "unknown error"}`);
  }

  return c.json(
    {
      document_id: documentId,
      title,
      total_docs: result.totalDocs,
      num_success: result.numSuccess,
    },
    201,
  );
});

// DELETE /:id — remove from document index + DB
documentsRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const doc = await queryOne<{ id: string }>("SELECT id FROM document WHERE id = $1", [id]);
  if (!doc) throw new NotFoundError("Document");

  const deletedFromIndex = await deleteDocumentChunks([id]);
  const deletedDbChunks = await query<{ count: string }>(
    "WITH d AS (DELETE FROM chunk WHERE document_id = $1 RETURNING 1) SELECT count(*)::text AS count FROM d",
    [id],
  );
  await query("DELETE FROM document WHERE id = $1", [id]);

  return c.json({
    deleted: true,
    document_id: id,
    deleted_chunks_from_index: deletedFromIndex,
    deleted_chunks_from_db: Number.parseInt(deletedDbChunks.rows[0]?.count ?? "0", 10),
  });
});
