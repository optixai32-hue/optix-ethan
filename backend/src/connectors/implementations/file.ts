/**
 * Owned by Task 2-d. Port of backend/onyx/connectors/file/connector.py
 * (LocalFileConnector).
 *
 * Python source:
 *   - /home/z/onyx/backend/onyx/connectors/file/connector.py
 *     (LocalFileConnector: `file_locations` are FileStore ids, `file_names`
 *      display names; load_from_state iterates each file, extracts text and
 *      yields Documents with TextSections; doc ids from file_document_id())
 *   - /home/z/onyx/backend/onyx/connectors/file/metadata.py
 *     (file_document_id: `FILE_CONNECTOR__<file_id>` id convention)
 *
 * SANDBOX ADAPTATION (documented deviation): the Python connector reads file
 * bytes from the S3/GCS-backed FileStore via `file_locations`. In onyx-ts the
 * file contents reach the connector in one of two ways:
 *   1. inline via the credential JSON: { files: [{ name, content }] } — a
 *      direct port of uploading file bytes (content is text; binary
 *      extraction lives in file_processing, owned by another task), or
 *   2. via connector_specific_config { file_names: [...] } — each entry is a
 *      key in the local file store (src/storage/file_store.ts), read at sync
 *      time and decoded as UTF-8 text.
 * Missing/unreadable files are logged and skipped (matching the Python
 * connector's "No file record found ... skipping" behavior).
 */
import type { ConnectorDoc, SlimDocMetadata } from "../../types/domain.js";
import type { ConnectorRunner } from "../framework.js";
import { loadState, saveState } from "../framework.js";
import { getFile } from "../../storage/file_store.js";
import { getLogger } from "../../utils/logger.js";

const logger = getLogger("connectors.file");

/** Port of connectors/file/metadata.py _DOCUMENT_ID_PREFIX. */
const DOCUMENT_ID_PREFIX = "FILE_CONNECTOR__";

interface InlineFile {
  name: string;
  content: string;
}

function isInlineFile(value: unknown): value is InlineFile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === "string" && typeof v.content === "string";
}

export class FileConnectorRunner implements ConnectorRunner {
  private readonly connectorId: number;
  private readonly fileNames: string[];
  private readonly inlineFiles: InlineFile[];
  private docs: ConnectorDoc[] | null = null;

  constructor(
    connectorId: number,
    specificConfig: Record<string, unknown>,
    credentials: Record<string, unknown>,
  ) {
    this.connectorId = connectorId;
    const rawNames = specificConfig.file_names;
    this.fileNames = Array.isArray(rawNames) ? rawNames.filter((n): n is string => typeof n === "string") : [];
    const rawFiles = credentials.files;
    this.inlineFiles = Array.isArray(rawFiles) ? rawFiles.filter(isInlineFile) : [];
  }

  /**
   * Build the full document set (port of load_from_state's per-file processing).
   * Result is cached per runner instance; sync state records the doc ids.
   */
  private async ensureDocs(): Promise<ConnectorDoc[]> {
    if (this.docs !== null) return this.docs;
    const docs: ConnectorDoc[] = [];

    for (const inline of this.inlineFiles) {
      docs.push({
        id: `${DOCUMENT_ID_PREFIX}${inline.name}`,
        title: inline.name,
        sections: [{ text: inline.content }],
        metadata: { file_name: inline.name },
        doc_updated_at: new Date().toISOString(),
      });
    }

    for (const name of this.fileNames) {
      const bytes = await getFile(name);
      if (bytes === null) {
        logger.warning("No file found in file store; skipping.", {
          connectorId: this.connectorId,
          fileKey: name,
        });
        continue;
      }
      const content = new TextDecoder().decode(bytes);
      if (!content.trim()) {
        logger.warning("File has no extractable text; skipping.", {
          connectorId: this.connectorId,
          fileKey: name,
        });
        continue;
      }
      docs.push({
        id: `${DOCUMENT_ID_PREFIX}${name}`,
        title: name,
        sections: [{ text: content.trim() }],
        metadata: { file_name: name },
        doc_updated_at: new Date().toISOString(),
      });
    }

    this.docs = docs;
    return docs;
  }

  /**
   * Port of LocalFileConnector.load_from_state: produce the current document
   * set (here: materialize + cache it) and return a state summary. The Python
   * generator yields Document batches; the TS runtime consumes the cached docs
   * via retrieve_all_slim_docs/fetch_docs instead.
   */
  async load_from_state(): Promise<Record<string, unknown>> {
    const docs = await this.ensureDocs();
    const prior = await loadState(this.connectorId);
    const lastSyncAt = new Date().toISOString();
    await saveState(this.connectorId, {
      ...prior,
      docIds: docs.map((d) => d.id),
      lastSyncAt,
    });
    return {
      docCount: docs.length,
      docIds: docs.map((d) => d.id),
      fileNames: [...this.fileNames, ...this.inlineFiles.map((f) => f.name)],
      lastSyncAt,
    };
  }

  /** Port of SlimConnector.retrieve_all_slim_docs: ids/titles only, no content. */
  async retrieve_all_slim_docs(): Promise<SlimDocMetadata[]> {
    const docs = await this.ensureDocs();
    return docs.map((d) => ({
      id: d.id,
      title: d.title,
      doc_updated_at: d.doc_updated_at,
    }));
  }

  /** Port of the checkpointed flow's fetch_docs(doc_ids): full content per id. */
  async fetch_docs(doc_ids: string[]): Promise<ConnectorDoc[]> {
    const docs = await this.ensureDocs();
    const wanted = new Set(doc_ids);
    return docs.filter((d) => wanted.has(d.id));
  }
}
