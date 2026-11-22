/**
 * Owned by Task 2-d. Connector background task entrypoints — mirrors the
 * Python task module split: backend/onyx/background/celery/tasks/docfetching/
 * tasks.py holds the connector index task + its enqueue helpers
 * (task_creation_utils.py builds + applies the docfetching task). The
 * handlers live in tasks.ts; this module is the producer-facing wrapper.
 */
import { enqueueTask, TaskPriority } from "./tasks.js";

export { TASK_REGISTRY, registerBuiltInTasks, registerTask, TaskPriority } from "./tasks.js";

/** Port of docfetching/task_creation_utils: queue one connector sync. */
export async function enqueueConnectorSync(
  ccPairId: number,
  priority: number = TaskPriority.MEDIUM,
): Promise<number> {
  return enqueueTask("connector_sync", { ccPairId }, priority);
}

/** Port of beat's check-for-indexing fanout as a one-shot producer helper. */
export async function enqueueConnectorSyncAll(): Promise<number> {
  return enqueueTask("connector_sync_all", {}, TaskPriority.MEDIUM);
}
