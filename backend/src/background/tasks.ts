/**
 * Owned by Task 2-d. Port of the background task layer — the celery task
 * registry + queue producer (replacement for onyx/background/celery).
 *
 * Python sources consulted:
 *   - /home/z/onyx/backend/onyx/background/celery/tasks/beat_schedule.py
 *     (periodic task templates: check-for-indexing every 15s etc.; onyx-ts
 *      stores the equivalent in the recurring_task table with cron strings)
 *   - /home/z/onyx/backend/onyx/background/celery/tasks/docfetching/tasks.py
 *     (the connector index task: fetch cc_pair -> build connector via factory ->
 *      transition IndexAttempt to in_progress -> enumerate slim docs ->
 *      fetch full docs -> hand batches to the indexing pipeline -> mark the
 *      attempt completed/failed with doc counts)
 *   - /home/z/onyx/backend/onyx/background/indexing/run_docfetching.py
 *     (_get_connector_runner + slim retrieval -> fetch_docs(doc_ids) flow,
 *      select_docprocessing_priority: first-time indexing outranks refreshes)
 *   - /home/z/onyx/backend/onyx/configs/constants.py
 *     (OnyxCeleryTask names: check_for_indexing, targeted_reindex_task; queue
 *      priorities — note celery's priority number is inverted, this port uses
 *      "higher number = run first" per the task_queue claim query)
 *   - /home/z/onyx/backend/onyx/connectors/factory.py (build_connector)
 *
 * Task names (contract): "connector_sync" {ccPairId}, "connector_sync_all",
 * "reindex_document". Rows live in the task_queue table (args jsonb,
 * status queued|running|complete|failed) — the DB-backed celery broker
 * replacement claimed by background/scheduler.ts with FOR UPDATE SKIP LOCKED.
 */
import { query, queryOne } from "../db/client";
import { getLogger } from "../utils/logger";
import { buildConnectorRunner } from "../connectors/factory";
import { saveState } from "../connectors/framework";
import { runIndexingPipeline } from "../indexing/pipeline";
import type { ConnectorDoc, SlimDocMetadata } from "../types/domain";

const logger = getLogger("background.tasks");

export type TaskHandler = (args: Record<string, unknown>) => Promise<void>;

/** Task registry — the celery `@shared_task` equivalent. */
export const TASK_REGISTRY = new Map<string, TaskHandler>();

/** Register (or replace) a task handler. */
export function registerTask(type: string, handler: TaskHandler): void {
  TASK_REGISTRY.set(type, handler);
  logger.debug("task registered", { type });
}

export function getTaskHandler(type: string): TaskHandler | undefined {
  return TASK_REGISTRY.get(type);
}

/** Port of OnyxCeleryPriority, re-pointed so higher = more urgent (claim query orders by priority DESC). */
export const TaskPriority = { HIGH: 10, MEDIUM: 5, LOW: 0 } as const;

const MAX_ERROR_MSG_LENGTH = 2000;

function truncateError(err: unknown): string {
  const msg = String(err instanceof Error ? err.message : err);
  return msg.length > MAX_ERROR_MSG_LENGTH ? `${msg.slice(0, MAX_ERROR_MSG_LENGTH)}...` : msg;
}

function coerceId(value: unknown, field: string): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new Error(`task arg '${field}' must be a number, got: ${String(value)}`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Queue producer (port of celery .apply_async / task_creation_utils)
// ---------------------------------------------------------------------------

/** Insert a task row into the DB-backed queue. Returns the task id. */
export async function enqueueTask(
  type: string,
  args: Record<string, unknown>,
  priority: number = TaskPriority.MEDIUM,
): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO task_queue (type, args, status, priority, attempts)
     VALUES ($1, $2::jsonb, 'queued', $3, 0)
     RETURNING id`,
    [type, JSON.stringify(args), priority],
  );
  const id = res.rows[0]?.id;
  logger.info("task enqueued", { taskId: id, type, priority });
  return id;
}

// ---------------------------------------------------------------------------
// connector_sync — port of the docfetching connector index task
// ---------------------------------------------------------------------------

type CcPairRow = {
  cc_pair_id: number;
  connector_id: number;
  source: string;
  connector_specific_config: Record<string, unknown> | null;
  credential_json: Record<string, unknown> | null;
};

/**
 * Port of the docfetching task + run_docfetching flow:
 *   1. load connector + credential + cc_pair rows,
 *   2. build a ConnectorRunner via the factory,
 *   3. create an IndexAttempt (status in_progress),
 *   4. runner.load_from_state() (enumerate + persist connector state),
 *   5. retrieve_all_slim_docs -> fetch_docs(doc_ids),
 *   6. runIndexingPipeline(docs, source, indexAttemptId),
 *   7. mark the attempt completed/failed with doc counts.
 * Any failure marks the attempt failed AND rethrows so the queue row is
 * marked failed by the worker loop (a failing task never kills the worker).
 */
async function connectorSyncTask(args: Record<string, unknown>): Promise<void> {
  const ccPairId = coerceId(args.ccPairId, "ccPairId");

  const ccPair = await queryOne<CcPairRow>(
    `SELECT cp.id AS cc_pair_id, c.id AS connector_id, c.source,
            c.connector_specific_config, cr.credential_json
     FROM connector_credential_pair cp
     JOIN connector c ON c.id = cp.connector_id
     JOIN credential cr ON cr.id = cp.credential_id
     WHERE cp.id = $1`,
    [ccPairId],
  );
  if (!ccPair) {
    throw new Error(`connector_credential_pair ${ccPairId} not found`);
  }

  const attempt = await queryOne<{ id: number }>(
    `INSERT INTO index_attempt (connector_id, cc_pair_id, status, total_docs, num_success, num_failed)
     VALUES ($1, $2, 'in_progress', 0, 0, 0)
     RETURNING id`,
    [ccPair.connector_id, ccPair.cc_pair_id],
  );
  if (!attempt) {
    throw new Error(`failed to create index_attempt for cc_pair ${ccPairId}`);
  }
  const indexAttemptId = attempt.id;
  logger.info("index attempt started", {
    indexAttemptId,
    ccPairId,
    connectorId: ccPair.connector_id,
    source: ccPair.source,
  });

  try {
    const runner = buildConnectorRunner(
      ccPair.connector_id,
      ccPair.source,
      ccPair.connector_specific_config ?? {},
      ccPair.credential_json ?? {},
    );

    // Port of ConnectorRunner.load_from_state side effects (state snapshot).
    const state = await runner.load_from_state();
    logger.debug("connector state loaded", { ccPairId, state });

    const slimDocs: SlimDocMetadata[] = await runner.retrieve_all_slim_docs();
    const docIds = slimDocs.map((d) => d.id);
    const docs: ConnectorDoc[] = await runner.fetch_docs(docIds);

    const result = await runIndexingPipeline(docs, ccPair.source, indexAttemptId);

    await query(
      `UPDATE index_attempt
       SET status = 'completed', total_docs = $2, num_success = $3, num_failed = $4,
           time_updated = now()
       WHERE id = $1`,
      [indexAttemptId, result.totalDocs, result.numSuccess, result.numFailed],
    );
    await saveState(ccPair.connector_id, { lastSyncAt: new Date().toISOString() });
    logger.info("index attempt completed", {
      indexAttemptId,
      ccPairId,
      totalDocs: result.totalDocs,
      numSuccess: result.numSuccess,
      numFailed: result.numFailed,
    });
  } catch (err) {
    const errorMsg = truncateError(err);
    await query(
      `UPDATE index_attempt
       SET status = 'failed', error_msg = $2, time_updated = now()
       WHERE id = $1`,
      [indexAttemptId, errorMsg],
    ).catch((markErr) => {
      logger.error("failed to mark index_attempt failed", {
        indexAttemptId,
        error: String(markErr),
      });
    });
    logger.error("index attempt failed", { indexAttemptId, ccPairId, error: errorMsg });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// connector_sync_all — port of beat's check-for-indexing fanout
// ---------------------------------------------------------------------------

/**
 * Enqueue a connector_sync task for every connector-credential pair
 * (the onyx-ts equivalent of beat's `check_for_indexing` -> per-cc_pair
 * docfetching task dispatch).
 */
async function connectorSyncAllTask(_args: Record<string, unknown>): Promise<void> {
  const res = await query<{ id: number }>(
    `SELECT id FROM connector_credential_pair ORDER BY id`,
  );
  for (const row of res.rows) {
    await enqueueTask("connector_sync", { ccPairId: row.id }, TaskPriority.MEDIUM);
  }
  logger.info("connector_sync_all fanned out", { ccPairs: res.rows.length });
}

// ---------------------------------------------------------------------------
// reindex_document — placeholder for targeted_reindex_task
// ---------------------------------------------------------------------------

/**
 * Port of OnyxCeleryTask.TARGETED_REINDEX_TASK. Not implemented in onyx-ts:
 * targeted reindexing needs the doc-processing re-chunk path. Log a clear
 * error and no-op (the task completes instead of retrying forever).
 */
async function reindexDocumentTask(args: Record<string, unknown>): Promise<void> {
  logger.error(
    "reindex_document is not ported (Task 2-d placeholder). Trigger a full connector_sync instead.",
    { args },
  );
}

// ---------------------------------------------------------------------------
// Built-in registration (idempotent; called by worker.ts on boot)
// ---------------------------------------------------------------------------

let builtInRegistered = false;

export function registerBuiltInTasks(): void {
  if (builtInRegistered) return;
  registerTask("connector_sync", connectorSyncTask);
  registerTask("connector_sync_all", connectorSyncAllTask);
  registerTask("reindex_document", reindexDocumentTask);
  builtInRegistered = true;
  logger.info("built-in tasks registered", {
    types: [...TASK_REGISTRY.keys()],
  });
}

/** Test/diagnostic hook: whether the built-ins are registered. */
export function builtInTasksRegistered(): boolean {
  return builtInRegistered;
}
