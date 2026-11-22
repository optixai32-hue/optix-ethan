/**
 * One-time per-process init for the serverless runtime: DB migrations +
 * LLM provider seeding (equivalent of the Bun entry's main() preamble).
 * Idempotent — migrations are IF NOT EXISTS based and seeding checks the table.
 */
import { getLogger } from "../utils/logger.js";
import { runMigrations } from "../db/migrations/runner.js";
import { ensureDevPresetLlmProvider, ensureKiloProvider } from "../llm/setup.js";

const logger = getLogger("api.vercel");

let initPromise: Promise<void> | null = null;

async function doInit(): Promise<void> {
  try {
    await runMigrations();
    await ensureDevPresetLlmProvider();
    // Kilo gateway seed (idempotent); covered by the same swallow-and-continue
    // catch below — a failed optional-provider seed must not fail the request.
    try {
      // Kilo gateway seed: boot must survive a failed seed (the provider is
      // optional and env-gated at call time), so a throw here is logged and
      // swallowed.
      await ensureKiloProvider();
    } catch (err) {
      logger.error("kilo gateway llm seed failed (continuing)", { error: String(err) });
    }
    logger.info("serverless init complete (migrations + llm seed)");
  } catch (err) {
    // Never fail the request because of init: migrations may race on cold
    // starts or the DB may be briefly unavailable. The first DB query that
    // actually needs the schema will surface a real error if truly broken.
    logger.error("serverless init failed (continuing)", { error: String(err) });
  }
}

/** Run once per process; subsequent calls await the same promise. */
export function ensureServerlessInit(): Promise<void> {
  if (!initPromise) {
    initPromise = doInit();
  }
  return initPromise;
}
