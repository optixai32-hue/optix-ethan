/**
 * Migration runner — alembic upgrade head equivalent.
 * Uses an alembic_version-equivalent table (`onyx_schema_versions`).
 * Task 2-a owns the ordered SQL in ./versions.ts; this runner executes pending
 * versions in order inside transactions.
 *
 * Concurrency: the api server and the background worker both run this at boot
 * (Dockerfile CMD parity: `alembic upgrade head && uvicorn ...` / celery worker
 * entrypoint). A session-level Postgres advisory lock serializes runners, and
 * the applied-set is re-read inside the lock — mirroring alembic's own
 * take-a-lock-before-upgrade behavior.
 */
import { getDb } from "../client.js";
import { IS_SERVERLESS_SHARED_DB } from "../../configs/constants.js";
import { getLogger } from "../../utils/logger.js";

export interface MigrationVersion {
  /** unique short id, e.g. "0001" — ordering is by array position */
  id: string;
  /** original alembic-equivalent name (documentation) */
  name: string;
  sql: string;
}

const logger = getLogger("db.migrations");

const CREATE_VERSION_TABLE = `
CREATE TABLE IF NOT EXISTS onyx_schema_versions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

// Fixed key for the session-level advisory lock (arbitrary constant).
const MIGRATION_LOCK_KEY = 74123901;

export async function runMigrations(): Promise<void> {
  const { MIGRATIONS } = await import("./versions.js");
  const client = await getDb().connect();
  try {
    await client.query(CREATE_VERSION_TABLE);
    // Serialize concurrent runners (api server + worker booting together).
    // NOTE: session-level advisory locks are unavailable under transaction-
    // pooling (Supabase pooler / PgBouncer transaction mode) — the lock query
    // can hang forever there. Use a bounded attempt (statement_timeout) and
    // proceed WITHOUT the lock on failure: migrations are IF NOT EXISTS
    // idempotent, so a rare double-run is safe.
    // Session-level advisory locks are UNSAFE on transaction poolers
    // (Supavisor transaction mode): the lock outlives the transaction on the
    // parked server session and every later runner blocks forever. When a
    // shared/serverless deployment is detected (ONYX_DB_SCHEMA or
    // ONYX_SERVERLESS), skip locking entirely — migrations are IF NOT EXISTS
    // idempotent, so a rare concurrent double-run is safe.
    let lockAcquired = false;
    const sharedDb = IS_SERVERLESS_SHARED_DB;
    if (!sharedDb) {
      try {
        await client.query("SET statement_timeout = '5s'");
        await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
        lockAcquired = true;
        await client.query("SET statement_timeout = 0");
      } catch (lockErr) {
        logger.warning("migration advisory lock unavailable — continuing unlocked", {
          error: String(lockErr),
        });
      }
    }
    try {
      const applied = await client.query<{ id: string }>(
        "SELECT id FROM onyx_schema_versions",
      );
      const appliedIds = new Set(applied.rows.map((r) => r.id));

      const pending = MIGRATIONS.filter((m) => !appliedIds.has(m.id));
      if (pending.length === 0) {
        logger.debug("schema up to date");
        return;
      }
      for (const migration of pending) {
        logger.info(`applying migration ${migration.id}: ${migration.name}`);
        await client.query("BEGIN");
        try {
          await client.query(migration.sql);
          await client.query(
            "INSERT INTO onyx_schema_versions (id, name) VALUES ($1, $2)",
            [migration.id, migration.name],
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        }
      }
      logger.info(`applied ${pending.length} migrations`);
    } finally {
      if (lockAcquired) {
        try {
          await client.query("SET statement_timeout = 0");
          await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
        } catch (unlockErr) {
          logger.warning("migration advisory unlock failed", { error: String(unlockErr) });
        }
      }
    }
  } finally {
    client.release();
  }
}
