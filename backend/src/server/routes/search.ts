/**
 * Search API routes — TypeScript port of the search endpoints in
 * backend/onyx/server/features/search/api.py (POST search returning SearchDoc
 * lists) and the context-building blocks of
 * backend/onyx/tools/tool_implementations/search/search_utils.py
 * (section_to_dict L120 — the numbered document blocks fed to LLM prompts),
 * plus the OpenSearch health surface of
 * backend/onyx/server/manage/opensearch_health.
 *
 * POST /           { query, num_hits?, rerank?, persona_id?, filters? }
 *                  -> { docs: SearchDoc[], llm_ready: string }
 * GET  /admin/status -> cluster health + document index stats
 */
import { Hono } from "hono";
import { z } from "zod";
import { searchDocuments } from "../../search/orchestration";
import { DOCUMENT_INDEX_NAME } from "../../indexing/document_index/opensearch_index";
import { countByQuery, getClusterHealth, indexExists } from "../../vector_db/client";
import { InvalidRequestError } from "../../utils/errors";
import { getLogger } from "../../utils/logger";
import type { SearchDoc } from "../../types/domain";

const logger = getLogger("server.routes.search");

export const searchRoutes = new Hono();

const searchRequestSchema = z.object({
  query: z.string().min(1),
  num_hits: z.number().int().positive().optional(),
  rerank: z.boolean().optional(),
  persona_id: z.number().int().optional().nullable(),
  filters: z
    .object({
      source_type: z.string().optional(),
      document_set: z.string().optional(),
    })
    .optional(),
});

/** Numbered [1]..[n] context string like Onyx builds for LLM prompts. */
function buildLlmReady(docs: SearchDoc[]): string {
  return docs
    .map((doc, i) => {
      const meta = Object.entries(doc.metadata)
        .slice(0, 5)
        .map(([k, v]) => `${k}: ${v}`)
        .join("; ");
      const lines = [
        `[${i + 1}]`,
        `Title: ${doc.semantic_identifier || doc.title}`,
        `Source: ${doc.source_type}`,
        meta.length > 0 ? `Metadata: ${meta}` : null,
        doc.doc_updated_at ? `Updated: ${doc.doc_updated_at}` : null,
        `Content: ${doc.content}`,
      ].filter((line): line is string => line !== null);
      return lines.join("\n");
    })
    .join("\n\n");
}

searchRoutes.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = searchRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidRequestError(`Invalid search request: ${parsed.error.message}`);
  }
  const { query, num_hits, rerank, persona_id, filters } = parsed.data;
  const docs = await searchDocuments({
    query,
    numHits: num_hits,
    rerank: rerank ?? false,
    personaId: persona_id ?? null,
    filters: filters
      ? { sourceType: filters.source_type, documentSet: filters.document_set }
      : undefined,
  });
  return c.json({ docs, llm_ready: buildLlmReady(docs) });
});

searchRoutes.get("/admin/status", async (c) => {
  const exists = await indexExists(DOCUMENT_INDEX_NAME).catch(() => false);
  let docCount: number | null = null;
  if (exists) {
    docCount = await countByQuery(DOCUMENT_INDEX_NAME).catch(() => null);
  }
  const health = await getClusterHealth().catch((err) => {
    logger.warning("cluster health fetch failed", { error: String(err) });
    return { status: "unreachable" as const };
  });
  return c.json({
    cluster_health: health,
    document_index: {
      name: DOCUMENT_INDEX_NAME,
      exists,
      doc_count: docCount,
    },
  });
});
