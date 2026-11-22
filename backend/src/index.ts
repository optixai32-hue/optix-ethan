/**
 * API server entry — Onyx Standard api_server equivalent (port 8080).
 * Runs `bun run dev` in mini-services/onyx-ts.
 * Migrations are applied on boot (Dockerfile CMD equivalent: alembic upgrade head && uvicorn).
 *
 * The Hono app itself lives in src/server/app.ts so the Vercel serverless
 * entry (api/[...path].ts) can mount the identical surface on Node.
 */
import { API_PORT } from "./configs/constants.js";
import { getLogger } from "./utils/logger.js";
import { runMigrations } from "./db/migrations/runner.js";
import { app } from "./server/app.js";
import { ensureDevPresetLlmProvider, ensureKiloProvider } from "./llm/setup.js";

const logger = getLogger("api.server");

async function main() {
  await runMigrations();
  await ensureDevPresetLlmProvider();
  try {
    // Kilo gateway seed: boot must survive a failed seed (the provider is
    // optional and env-gated at call time), so unlike the dev preset above a
    // throw here is logged and swallowed.
    await ensureKiloProvider();
  } catch (err) {
    logger.error("kilo gateway llm seed failed (continuing)", { error: String(err) });
  }
  Bun.serve({
    port: API_PORT,
    fetch: app.fetch,
    idleTimeout: 60,
  });
  logger.info(`onyx-ts api server listening on :${API_PORT} (Standard mode)`);
}

main().catch((err) => {
  logger.error("fatal startup error", { error: String(err) });
  process.exit(1);
});
