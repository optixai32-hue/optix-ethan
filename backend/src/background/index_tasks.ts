/**
 * Owned by Task 2-d. Indexing background task entrypoints — mirrors the
 * Python task module split: backend/onyx/background/celery/tasks/docprocessing/
 * tasks.py holds the doc-processing (chunk + embed + index) tasks and the
 * targeted reindex entrypoint. The connector fetch side lives in
 * connector_tasks.ts; the actual pipeline runs in src/indexing (Task 2-c).
 */
import { enqueueTask, TaskPriority } from "./tasks.js";

export { TASK_REGISTRY, registerBuiltInTasks, registerTask, TaskPriority } from "./tasks.js";

/**
 * Port of OnyxCeleryTask.TARGETED_REINDEX_TASK producer. The handler is a
 * documented no-op placeholder (see tasks.ts reindexDocumentTask).
 */
export async function enqueueReindexDocument(
  documentId: string,
  priority: number = TaskPriority.LOW,
): Promise<number> {
  return enqueueTask("reindex_document", { documentId }, priority);
}
