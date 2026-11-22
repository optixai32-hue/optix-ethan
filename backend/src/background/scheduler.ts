/**
 * Owned by Task 2-d. Background worker loop + scheduler — the celery worker +
 * celerybeat replacement for onyx-ts.
 *
 * Python sources consulted:
 *   - /home/z/onyx/backend/onyx/background/celery/tasks/beat_schedule.py
 *     (beat_task_templates: periodic tasks with schedules; onyx-ts replaces
 *      beat's schedule entries with rows in the recurring_task table that are
 *      evaluated against 5-field cron expressions every schedulerIntervalMs)
 *   - /home/z/onyx/backend/onyx/background/celery/apps/beat.py
 *     (the beat loop: fire a task when its schedule is due; this port adds a
 *      60s de-duplication window so one cron minute fires at most once)
 *   - /home/z/onyx/backend/onyx/background/celery/apps/docfetching.py +
 *     configs/*.py (worker concurrency / prefetch semantics -> fixed pool of
 *      `concurrency` in-flight tasks, claimed with FOR UPDATE SKIP LOCKED)
 *   - /home/z/onyx/backend/onyx/background/task_utils.py
 *     (DB-backed task coordination helpers)
 *
 * Semantics:
 *   (a) worker loop — every WORKER_POLL_INTERVAL_MS claim up to
 *       (concurrency - inFlight) queued tasks with
 *       `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING *`
 *       inside a transaction (multi-worker safe), execute each with
 *       withRetry(attempts=2), then mark complete/failed (+error message).
 *       attempts is incremented at claim time. A failing task never kills the
 *       worker; unknown task types are marked failed, not retried.
 *   (b) scheduler loop — every schedulerIntervalMs evaluate enabled
 *       recurring_task rows: fire when cronMatches(cron, now) AND
 *       last_run_at is older than the 60s de-dup window, enqueue the payload
 *       as a task and update last_run_at. Seeds the
 *       default_connector_sync_check recurring row (task connector_sync_all,
 *       every-10-minutes cron, spec-mandated) on first run.
 *   Stale 'running' rows older than 10 minutes are requeued on worker start
 *   (crash recovery; celery's acks_late/visibility timeout equivalent).
 */
import { query, withTransaction } from "../db/client.js";
import { WORKER_POLL_INTERVAL_MS } from "../configs/constants.js";
import { getLogger, withRetry } from "../utils/logger.js";
import { cronMatches } from "./cron.js";
import { enqueueTask, getTaskHandler } from "./tasks.js";

const logger = getLogger("background.scheduler");

/** A task_queue row as RETURNING * gives it (args jsonb -> parsed object or string). */
type TaskQueueRow = {
  id: number;
  type: string;
  args: unknown;
  status: string;
  priority: number;
  attempts: number;
  error: string | null;
  created_at: Date;
  updated_at: Date;
};

type RecurringTaskRowT = {
  id: number;
  name: string;
  task_type: string;
  cron: string;
  payload: unknown;
  last_run_at: Date | null;
  enabled: boolean;
};

const STALE_RUNNING_REQUEUE_MS = 10 * 60 * 1000;
const SCHEDULER_DEDUP_WINDOW_MS = 60_000;
const SEED_RECURRING_TASK_NAME = "default_connector_sync_check";

const state = {
  started: false,
  stopped: false,
  workerTimer: null as ReturnType<typeof setInterval> | null,
  schedulerTimer: null as ReturnType<typeof setInterval> | null,
  inFlight: new Set<Promise<void>>(),
  stopWaiters: new Array<() => void>(),
};

// ---------------------------------------------------------------------------
// Seeding + crash recovery
// ---------------------------------------------------------------------------

/** Seed the default recurring task (no-op if it already exists). */
async function seedRecurringTasks(): Promise<void> {
  const res = await query<{ name: string }>(
    `INSERT INTO recurring_task (name, task_type, cron, payload, last_run_at, enabled)
     SELECT $1, 'connector_sync_all', '*/10 * * * *', '{}'::jsonb, NULL, true
     WHERE NOT EXISTS (SELECT 1 FROM recurring_task WHERE name = $1)
     RETURNING name`,
    [SEED_RECURRING_TASK_NAME],
  );
  if (res.rows.length > 0) {
    logger.info("seeded recurring task", {
      name: SEED_RECURRING_TASK_NAME,
      taskType: "connector_sync_all",
      cron: "*/10 * * * *",
    });
  }
}

/** Requeue stale 'running' rows left behind by a crashed worker. */
async function requeueStaleRunningTasks(): Promise<void> {
  const res = await query<{ id: number; type: string }>(
    `UPDATE task_queue
     SET status = 'queued',
         error = COALESCE(error, 'requeued after worker restart (stale running row)'),
         updated_at = now()
     WHERE status = 'running' AND updated_at < now() - ($1 || ' milliseconds')::interval
     RETURNING id, type`,
    [String(STALE_RUNNING_REQUEUE_MS)],
  );
  if (res.rows.length > 0) {
    logger.warning("requeued stale running tasks", { count: res.rows.length });
  }
}

// ---------------------------------------------------------------------------
// (a) Worker loop
// ---------------------------------------------------------------------------

/**
 * Claim up to `limit` queued tasks atomically (port of the celery worker
 * prefetch, DB-broker style). Attempts are incremented at claim time so a
 * worker crash still counts the attempt.
 */
async function claimTasks(limit: number): Promise<TaskQueueRow[]> {
  const rows = await withTransaction(async (client) => {
    const res = await client.query<TaskQueueRow>(
      `UPDATE task_queue
       SET status = 'running', attempts = attempts + 1, updated_at = now()
       WHERE id IN (
         SELECT id FROM task_queue
         WHERE status = 'queued'
         ORDER BY priority DESC, id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [limit],
    );
    return res.rows;
  });
  return rows;
}

function parseTaskArgs(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

async function completeTask(taskId: number): Promise<void> {
  await query(`UPDATE task_queue SET status = 'complete', updated_at = now() WHERE id = $1`, [
    taskId,
  ]);
}

async function failTask(taskId: number, error: string): Promise<void> {
  const msg = error.length > 2000 ? `${error.slice(0, 2000)}...` : error;
  await query(
    `UPDATE task_queue SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
    [taskId, msg],
  );
}

/** Execute one claimed task: run its handler with retry, then mark the row. */
async function executeTask(row: TaskQueueRow): Promise<void> {
  const handler = getTaskHandler(row.type);
  if (!handler) {
    await failTask(row.id, `no handler registered for task type '${row.type}'`);
    logger.error("task failed: no handler", { taskId: row.id, type: row.type });
    return;
  }
  const args = parseTaskArgs(row.args);
  try {
    await withRetry(() => handler(args), {
      attempts: 2,
      baseDelayMs: 500,
      logger,
      name: row.type,
    });
    await completeTask(row.id);
    logger.info("task complete", { taskId: row.id, type: row.type, attempts: row.attempts });
  } catch (err) {
    // Crash-safety: the task failed but the worker keeps running.
    const errorMsg = String(err instanceof Error ? err.message : err);
    await failTask(row.id, errorMsg).catch((markErr) => {
      logger.error("failed to mark task failed", {
        taskId: row.id,
        error: String(markErr),
      });
    });
    logger.error("task failed", { taskId: row.id, type: row.type, error: errorMsg });
  }
}

function tracked(promise: Promise<void>): Promise<void> {
  const wrapped = promise
    .catch(() => undefined) // executeTask never throws, but be defensive
    .finally(() => {
      state.inFlight.delete(wrapped);
      if (state.stopped && state.inFlight.size === 0) {
        for (const wake of state.stopWaiters) wake();
        state.stopWaiters = [];
      }
    });
  state.inFlight.add(wrapped);
  return wrapped;
}

/** One worker poll tick: claim + execute while pool capacity allows. */
async function workerPollTick(concurrency: number): Promise<void> {
  try {
    const capacity = concurrency - state.inFlight.size;
    if (capacity <= 0) return;
    const rows = await claimTasks(capacity);
    for (const row of rows) {
      logger.info("task claimed", { taskId: row.id, type: row.type, attempts: row.attempts });
      void tracked(executeTask(row));
    }
  } catch (err) {
    // Never let a DB hiccup kill the worker loop.
    logger.warning("worker poll tick failed", { error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// (b) Scheduler loop (celerybeat replacement)
// ---------------------------------------------------------------------------

/** Evaluate recurring tasks against the current time; fire + stamp due ones. */
async function schedulerTick(): Promise<void> {
  try {
    const res = await query<RecurringTaskRowT>(
      `SELECT id, name, task_type, cron, payload, last_run_at, enabled
       FROM recurring_task
       WHERE enabled = true`,
    );
    const now = new Date();
    for (const row of res.rows) {
      let due = false;
      try {
        due = cronMatches(row.cron, now);
      } catch (err) {
        logger.warning("invalid cron on recurring task", {
          name: row.name,
          cron: row.cron,
          error: String(err),
        });
        continue;
      }
      if (!due) continue;
      // 60s de-dup window: one cron minute fires at most once per task.
      if (row.last_run_at) {
        const lastMs = new Date(row.last_run_at).getTime();
        if (Number.isFinite(lastMs) && now.getTime() - lastMs < SCHEDULER_DEDUP_WINDOW_MS) {
          continue;
        }
      }
      const args = parseTaskArgs(row.payload);
      await enqueueTask(row.task_type, args);
      await query(`UPDATE recurring_task SET last_run_at = now() WHERE id = $1`, [row.id]);
      logger.info("recurring task fired", {
        name: row.name,
        taskType: row.task_type,
        cron: row.cron,
      });
    }
  } catch (err) {
    logger.warning("scheduler tick failed", { error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function startWorkerLoop(opts: {
  concurrency: number;
  schedulerIntervalMs: number;
}): void {
  if (state.started) {
    logger.warning("startWorkerLoop called but the worker loop is already running");
    return;
  }
  state.started = true;
  state.stopped = false;
  const concurrency = Math.max(1, opts.concurrency);
  const schedulerIntervalMs = Math.max(1_000, opts.schedulerIntervalMs);

  logger.info("worker loop starting", {
    concurrency,
    workerPollIntervalMs: WORKER_POLL_INTERVAL_MS,
    schedulerIntervalMs,
  });

  void (async () => {
    try {
      await seedRecurringTasks();
      await requeueStaleRunningTasks();
    } catch (err) {
      logger.warning("worker bootstrap (seed/requeue) failed", { error: String(err) });
    }
  })();

  // (a) worker loop
  state.workerTimer = setInterval(() => {
    void workerPollTick(concurrency);
  }, WORKER_POLL_INTERVAL_MS);

  // (b) scheduler loop (beat)
  state.schedulerTimer = setInterval(() => {
    void schedulerTick();
  }, schedulerIntervalMs);

  // Kick both loops immediately so a short-lived worker still does work.
  void workerPollTick(concurrency);
  void schedulerTick();
}

/**
 * Graceful shutdown: stop accepting polls, wait for in-flight tasks
 * (bounded by `timeoutMs`, default 10s), clear the timers.
 */
export async function stopWorker(timeoutMs: number = 10_000): Promise<void> {
  if (!state.started) return;
  state.stopped = true;
  if (state.workerTimer) clearInterval(state.workerTimer);
  if (state.schedulerTimer) clearInterval(state.schedulerTimer);
  state.workerTimer = null;
  state.schedulerTimer = null;
  state.started = false;
  logger.info("worker loop stopping", { inFlight: state.inFlight.size });

  if (state.inFlight.size > 0) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), timeoutMs);
      state.stopWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  logger.info("worker loop stopped");
}
