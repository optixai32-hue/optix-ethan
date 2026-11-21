/**
 * API server entry — Onyx Standard api_server equivalent (port 8080).
 * Runs `bun run dev` in mini-services/onyx-ts.
 * Migrations are applied on boot (Dockerfile CMD equivalent: alembic upgrade head && uvicorn).
 *
 * The Hono app itself lives in src/server/app.ts so the Vercel serverless
 * entry (api/[...path].ts) can mount the identical surface on Node.
 */
import { API_PORT } from "./configs/constants";
import { getLogger } from "./utils/logger";
import { runMigrations } from "./db/migrations/runner";
import { app } from "./server/app";
import { ensureDevPresetLlmProvider } from "./llm/setup";

const logger = getLogger("api.server");

async function main() {
  await runMigrations();
  await ensureDevPresetLlmProvider();
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
