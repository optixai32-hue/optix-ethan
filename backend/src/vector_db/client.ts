/**
 * OpenSearch REST client — TypeScript port of
 * backend/onyx/document_index/opensearch/client.py (the raw OpenSearch client
 * wrapper used by OpenSearchDocumentIndex in Standard mode).
 *
 * Ported operations (client.py): index_exists (L828), create_index (L772),
 * delete_index (L803), index_document (L1104), bulk_index_documents (L1183),
 * delete_by_query (L1388), count_by_query (L1485), search (L1814),
 * refresh_index (L2420).
 *
 * Uses plain fetch with Basic auth instead of the official opensearch-py
 * client; every request carries an AbortSignal.timeout so a hung cluster
 * cannot stall indexing/searching.
 */
import {
  OPENSEARCH_HOST,
  OPENSEARCH_PASSWORD,
  OPENSEARCH_USERNAME,
} from "../configs/constants.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger("vector_db.client");

const REQUEST_TIMEOUT_MS = 10_000;

export class OpenSearchRequestError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, path: string) {
    super(`OpenSearch request failed (${status}) on ${path}: ${body.slice(0, 500)}`);
    this.name = "OpenSearchRequestError";
    this.status = status;
    this.body = body;
  }
}

function basicAuthHeader(): string {
  const creds = `${OPENSEARCH_USERNAME}:${OPENSEARCH_PASSWORD}`;
  return `Basic ${Buffer.from(creds, "utf8").toString("base64")}`;
}

/** Low-level typed request helper (port of the opensearch-py dispatch in client.py). */
export async function opensearchRequest(
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE" | "HEAD",
  body?: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const url = `${OPENSEARCH_HOST.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new OpenSearchRequestError(res.status, text, path);
  }
  let json: Record<string, unknown> = {};
  if (text.trim().length > 0) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Some endpoints (e.g. HEAD) return empty bodies; leave json empty.
      json = {};
    }
  }
  return { status: res.status, json, text };
}

/** HEAD /{index} — port of client.py index_exists (L828). 404 means missing. */
export async function indexExists(indexName: string): Promise<boolean> {
  const url = `${OPENSEARCH_HOST.replace(/\/$/, "")}/${encodeURIComponent(indexName)}`;
  const res = await fetch(url, {
    method: "HEAD",
    headers: { Authorization: basicAuthHeader() },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new OpenSearchRequestError(res.status, await res.text(), `/${indexName}`);
}

/**
 * PUT /{index} with mappings + settings — port of client.py create_index (L772).
 * `index.knn` must be enabled for knn_vector fields to be searchable.
 */
export async function createIndex(
  indexName: string,
  mappings: Record<string, unknown>,
  settings: Record<string, unknown>,
): Promise<void> {
  await opensearchRequest(`/${encodeURIComponent(indexName)}`, "PUT", {
    mappings,
    settings,
  });
  logger.info("created OpenSearch index", { index: indexName });
}

export async function deleteIndex(indexName: string): Promise<boolean> {
  const exists = await indexExists(indexName);
  if (!exists) return false;
  await opensearchRequest(`/${encodeURIComponent(indexName)}`, "DELETE");
  return true;
}

export interface BulkIndexAction {
  indexId: string;
  document: Record<string, unknown>;
}

/**
 * POST /_bulk — port of client.py bulk_index_documents (L1183).
 * NDJSON body: one action line + one document line per item. Refresh is
 * deferred (matching Onyx, which refreshes at the end of a batch pipeline).
 */
export async function bulkIndex(
  indexName: string,
  actions: BulkIndexAction[],
): Promise<number> {
  if (actions.length === 0) return 0;
  const lines: string[] = [];
  for (const action of actions) {
    lines.push(
      JSON.stringify({ index: { _index: indexName, _id: action.indexId } }),
    );
    lines.push(JSON.stringify(action.document));
  }
  const ndjson = `${lines.join("\n")}\n`;
  const url = `${OPENSEARCH_HOST.replace(/\/$/, "")}/_bulk`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-ndjson",
    },
    body: ndjson,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new OpenSearchRequestError(res.status, text, "/_bulk");
  }
  let parsed: { errors?: boolean; items?: { index?: { status?: number; error?: unknown } }[] } = {};
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    parsed = {};
  }
  if (parsed.errors) {
    const firstFailed = parsed.items?.find((it) => it.index && (it.index.status ?? 500) >= 400);
    const detail = firstFailed?.index?.error
      ? JSON.stringify(firstFailed.index.error).slice(0, 500)
      : "unknown bulk item error";
    throw new Error(`OpenSearch bulk indexing reported item failures: ${detail}`);
  }
  return actions.length;
}

/** PUT /{index}/_doc/{id} — port of client.py index_document (L1104). */
export async function indexDocument(
  indexName: string,
  documentId: string,
  document: Record<string, unknown>,
): Promise<void> {
  await opensearchRequest(
    `/${encodeURIComponent(indexName)}/_doc/${encodeURIComponent(documentId)}`,
    "PUT",
    document,
  );
}

/**
 * POST /{index}/_search — port of client.py search (L1814).
 * Returns raw hits with their _source and _score so callers build domain rows.
 */
export interface OpenSearchHit {
  id: string;
  score: number | null;
  source: Record<string, unknown>;
}

export async function search(
  indexName: string,
  queryBody: Record<string, unknown>,
): Promise<OpenSearchHit[]> {
  const { json } = await opensearchRequest(
    `/${encodeURIComponent(indexName)}/_search`,
    "POST",
    queryBody,
  );
  const hits = (json["hits"] as { hits?: Record<string, unknown>[] } | undefined)?.hits ?? [];
  return hits.map((hit) => ({
    id: String(hit["_id"] ?? ""),
    score: typeof hit["_score"] === "number" ? (hit["_score"] as number) : null,
    source: (hit["_source"] as Record<string, unknown>) ?? {},
  }));
}

/**
 * POST /{index}/_delete_by_query — port of client.py delete_by_query (L1388).
 * `conflicts=proceed` mirrors Onyx: chunks may already be gone on reindex.
 */
export async function deleteByQuery(
  indexName: string,
  query: Record<string, unknown>,
): Promise<number> {
  const { json } = await opensearchRequest(
    `/${encodeURIComponent(indexName)}/_delete_by_query?conflicts=proceed&refresh=true`,
    "POST",
    { query },
  );
  return typeof json["deleted"] === "number" ? json["deleted"] : 0;
}

/** POST /{index}/_count with optional query — port of count_by_query (L1485). */
export async function countByQuery(
  indexName: string,
  query?: Record<string, unknown>,
): Promise<number> {
  const { json } = await opensearchRequest(
    `/${encodeURIComponent(indexName)}/_count`,
    "POST",
    query ? { query } : undefined,
  );
  return typeof json["count"] === "number" ? json["count"] : 0;
}

/** POST /{index}/_refresh — port of refresh_index (L2420). */
export async function refreshIndex(indexName: string): Promise<void> {
  await opensearchRequest(`/${encodeURIComponent(indexName)}/_refresh`, "POST");
}

/** GET /_cluster/health — used by the /search/admin/status route. */
export async function getClusterHealth(): Promise<Record<string, unknown>> {
  const { json } = await opensearchRequest("/_cluster/health", "GET");
  return json;
}
