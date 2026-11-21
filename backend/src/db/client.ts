/**
 * Postgres client — replacement for SQLAlchemy/asyncpg layer of Onyx Standard.
 * Single shared pool; all modules import { getDb } and run parameterized SQL.
 */
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { DB_SCHEMA, POSTGRES_URI, requirePostgresUri } from "../configs/constants";
import { getLogger } from "../utils/logger";

const logger = getLogger("db.client");

let pool: Pool | null = null;

export function getDb(): Pool {
  if (!pool) {
    const rawUri = requirePostgresUri();
    // Managed Postgres (Supabase pooler, Neon, etc.) requires TLS. pg 8 treats
    // sslmode=require as verify-full and rejects managed CA chains ("self-
    // signed certificate in certificate chain"), so strip sslmode/ssl from the
    // URI and pass an explicit ssl object instead. Local 127.0.0.1 stays plain.
    const isLocal = /@(127\.0\.0\.1|localhost)?:/.test(rawUri) || rawUri.includes("@[::1]:");
    const wantsTls = !isLocal && (rawUri.includes("sslmode=") || /pooler?\.?(supabase|neon|amazonaws|rds)\./.test(rawUri) || process.env.PGSSL === "require");
    const uri = wantsTls ? stripSslParams(rawUri) : rawUri;
    // Shared managed databases (Supabase with a pre-existing app schema)
    // may already contain colliding table names. The resolved DB_SCHEMA
    // (ONYX_DB_SCHEMA, or the automatic "onyx" default on shared hosted
    // poolers) isolates the onyx tables via the search_path startup
    // parameter (applies to every pooled connection).
    const dbSchema = DB_SCHEMA;
    pool = new Pool({
      connectionString: uri,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ...(dbSchema ? { options: `-c search_path=${dbSchema},public` } : {}),
      ...(wantsTls ? { ssl: { rejectUnauthorized: false } } : {}),
    });
    pool.on("error", (err) => {
      logger.error("pg pool error", { error: String(err) });
    });
  }
  return pool;
}

/** Remove sslmode/ssl query params from a Postgres URI (string-safe). */
function stripSslParams(uri: string): string {
  const qIndex = uri.indexOf("?");
  if (qIndex === -1) return uri;
  const base = uri.slice(0, qIndex);
  const kept: string[] = [];
  const query = uri.slice(qIndex + 1);
  for (const pair of query.split("&")) {
    const key = pair.split("=")[0]?.toLowerCase();
    if (key === "sslmode" || key === "ssl") continue;
    if (pair.length > 0) kept.push(pair);
  }
  if (kept.length === 0) return base;
  return base + "?" + kept.join("&");
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  return getDb().query<T>(sql, params as unknown[]);
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const res = await query<T>(sql, params);
  return res.rows[0] ?? null;
}

/** Run a transaction; rolls back on error. Equivalent to SQLAlchemy session.begin(). */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getDb().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export function parsePostgresUri(uri: string): { host: string; port: string } {
  const m = /host=([^\s&]+)/.exec(uri);
  const pm = /(?:\/\/[^:/]+:)(\d+)/.exec(uri);
  return { host: m?.[1] ?? "localhost", port: pm?.[1] ?? POSTGRES_URI ? "5432" : "5432" };
}

export { POSTGRES_URI };
