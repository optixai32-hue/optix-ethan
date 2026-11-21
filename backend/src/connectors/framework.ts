/**
 * Owned by Task 2-d. Port of the connector framework — base connector semantics.
 *
 * Python sources consulted:
 *   - /home/z/onyx/backend/onyx/connectors/interfaces.py
 *     (BaseConnector / LoadConnector / SlimConnector: load_from_state yields
 *      document batches, retrieve_all_slim_docs enumerates doc ids, and the
 *      checkpointed flow's fetch_docs(doc_ids) fetches full content for a set
 *      of previously enumerated ids)
 *   - /home/z/onyx/backend/onyx/connectors/connector_runner.py
 *     (ConnectorRunner: batching + combining connector types into one interface)
 *   - /home/z/onyx/backend/onyx/connectors/models.py
 *     (Document / TextSection / SlimDocument shapes -> types/domain.ts ConnectorDoc
 *      + SlimDocMetadata)
 *
 * Port shape: the Python generators (GenerateDocumentsOutput /
 * GenerateSlimDocumentOutput) collapse to three awaited calls — the runtime
 * (background/tasks.ts) drives load_from_state() once for side effects/state,
 * then retrieve_all_slim_docs() for the id set, then fetch_docs(ids) for full
 * content. Keep this interface EXACTLY: the factory (factory.ts) and the task
 * runtime depend on it.
 */
import type { ConnectorDoc, SlimDocMetadata } from "../types/domain";
import { kvGetJson, kvSetJson } from "../key_value_store/redis_compat";
import { getLogger } from "../utils/logger";

const logger = getLogger("connectors.framework");

export interface ConnectorRunner {
  load_from_state(): Promise<Record<string, unknown>>;
  retrieve_all_slim_docs(): Promise<SlimDocMetadata[]>;
  fetch_docs(doc_ids: string[]): Promise<ConnectorDoc[]>;
}

/** Keep the existing factory signature (connectorId, specificConfig, credentials). */
export type ConnectorFactory = (
  connectorId: number,
  specificConfig: Record<string, unknown>,
  credentials: Record<string, unknown>,
) => ConnectorRunner;

/**
 * Durable connector sync state persisted in the KV store
 * (Redis-backed via redis_compat) under `connector_state:<id>`.
 */
export interface ConnectorSyncState {
  lastSyncAt?: string;
  /** Doc ids known to the connector at last enumeration (slim-retrieval parity). */
  docIds?: string[];
}

/** Logical KV key for a connector's sync state. */
export function connectorStateKey(connectorId: number): string {
  return `connector_state:${connectorId}`;
}

/**
 * Load the persisted sync state for a connector; undefined when absent or
 * unreadable (fail-open, matching the KV layer's behavior).
 */
export async function loadState(connectorId: number): Promise<ConnectorSyncState | undefined> {
  const state = await kvGetJson<ConnectorSyncState>(connectorStateKey(connectorId));
  if (state === null) return undefined;
  return state;
}

/**
 * Merge + persist connector sync state. Failures inside the KV layer are
 * logged there and must not break a sync.
 */
export async function saveState(
  connectorId: number,
  patch: Partial<ConnectorSyncState>,
): Promise<void> {
  const current = (await loadState(connectorId)) ?? {};
  const next: ConnectorSyncState = { ...current, ...patch };
  await kvSetJson(connectorStateKey(connectorId), next);
  logger.debug("connector state saved", { connectorId, keys: Object.keys(next) });
}
