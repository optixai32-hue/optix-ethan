/**
 * Background worker entry — Onyx Standard `background` container equivalent.
 * Runs `bun run worker` in mini-services/onyx-ts. Consumes the DB-backed task
 * queue (celery + redis broker replacement) and runs the recurring scheduler
 * (celerybeat replacement).
 */
import { WORKER_CONCURRENCY, SCHEDULER_INTERVAL_MS } from "./configs/constants";
import { getLogger } from "./utils/logger";
import { runMigrations } from "./db/migrations/runner";
import { startWorkerLoop } from "./background/scheduler";
import { registerBuiltInTasks } from "./background/tasks";

const logger = getLogger("background.worker");

async function main() {
  await runMigrations();
  registerBuiltInTasks();
  logger.info(`onyx-ts background worker starting (concurrency=${WORKER_CONCURRENCY})`);
  startWorkerLoop({ concurrency: WORKER_CONCURRENCY, schedulerIntervalMs: SCHEDULER_INTERVAL_MS });
}

main().catch((err) => {
  logger.error("fatal worker startup error", { error: String(err) });
  process.exit(1);
});
