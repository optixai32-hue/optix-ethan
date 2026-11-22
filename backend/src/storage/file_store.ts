/**
 * Owned by Task 2-d. Port of backend/onyx/file_store.
 *
 * Python sources consulted:
 *   - /home/z/onyx/backend/onyx/file_store/file_store.py
 *     (FileStore ABC + save_file/read_file/delete_file semantics: content bytes in,
 *      file ids are opaque keys; list via get_object_keys_with_records/prefix scans)
 *   - /home/z/onyx/backend/onyx/file_store/constants.py (FILE_STORE_NAME / backends)
 *   - /home/z/onyx/backend/onyx/file_store/models.py (FileRecord metadata)
 *
 * Deviation from Standard: Onyx stores blobs in S3/GCS/Azure with a Postgres
 * `file_record` metadata table. The onyx-ts port uses a single LOCAL_FILE_STORE
 * backend (the sandbox's local filesystem under FILE_STORE_DIR) and keeps no
 * separate metadata table — the key IS the record. Path resolution is hardened
 * against traversal (no `..`, no absolute keys, resolved path must stay inside
 * the base directory), mirroring S3 key sanitization in s3_key_utils.py.
 */
import { mkdir, readdir, rm, writeFile, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { FILE_STORE_DIR } from "../configs/constants.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger("storage.file_store");

const BASE_DIR = resolve(FILE_STORE_DIR);

/** Refuse keys that could escape the base directory (port of s3_key_utils sanitization). */
function assertKeySafe(key: string): void {
  if (key.length === 0) {
    throw new Error("file store key must not be empty");
  }
  if (key.startsWith("/") || key.includes("\\") || key.includes("\0")) {
    throw new Error(`file store key must be a relative POSIX path: '${key}'`);
  }
  for (const segment of key.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`file store key contains invalid segment: '${key}'`);
    }
  }
  const resolved = resolve(join(BASE_DIR, key));
  if (resolved !== BASE_DIR && !resolved.startsWith(BASE_DIR + sep)) {
    throw new Error(`file store key escapes base directory: '${key}'`);
  }
}

/**
 * Store bytes at `key`. Creates parent directories as needed (mkdir -p).
 */
export async function putFile(key: string, bytes: Uint8Array): Promise<void> {
  assertKeySafe(key);
  const path = join(BASE_DIR, key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  logger.debug("putFile", { key, bytes: bytes.byteLength });
}

/**
 * Read bytes at `key`; null when the object does not exist
 * (port of read_file returning no record for unknown ids).
 */
export async function getFile(key: string): Promise<Uint8Array | null> {
  assertKeySafe(key);
  const path = join(BASE_DIR, key);
  try {
    const buf = await readFile(path);
    return new Uint8Array(buf);
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Delete the object at `key`. Idempotent: deleting a missing key is a no-op
 * (port of delete_file). Empty directories left behind are pruned best-effort.
 */
export async function deleteFile(key: string): Promise<void> {
  assertKeySafe(key);
  const path = join(BASE_DIR, key);
  await rm(path, { force: true, recursive: false });
  // Best-effort cleanup of now-empty parent directories up to the base dir.
  let parent = dirname(path);
  while (parent.length > BASE_DIR.length && parent.startsWith(BASE_DIR + sep)) {
    try {
      await rm(parent, { force: false, recursive: false });
    } catch {
      break; // not empty (or already gone) — stop pruning
    }
    parent = dirname(parent);
  }
}

/**
 * List object keys under `prefix` (recursive walk of the base directory,
 * port of prefix listing). Keys are returned as normalized relative POSIX paths.
 */
export async function listFiles(prefix: string): Promise<string[]> {
  if (prefix.startsWith("/") || prefix.includes("\\") || prefix.includes("\0") || prefix.split("/").includes("..")) {
    throw new Error(`file store prefix is not a safe relative path: '${prefix}'`);
  }
  await mkdir(BASE_DIR, { recursive: true });
  const normPrefix = normalize(prefix).replace(/\/+$/, "");
  const root = normPrefix === "" || normPrefix === "." ? BASE_DIR : join(BASE_DIR, normPrefix);
  const rootResolved = resolve(root);
  if (rootResolved !== BASE_DIR && !rootResolved.startsWith(BASE_DIR + sep)) {
    throw new Error(`file store prefix escapes base directory: '${prefix}'`);
  }
  let entries: Dirent[] = [];
  try {
    entries = (await readdir(rootResolved, {
      withFileTypes: true,
      recursive: true,
    })) as unknown as Dirent[];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }
  const keys: string[] = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      const parentRel = String(entry.parentPath).replace(rootResolved, "").replace(/^\//, "");
      const relKey = parentRel ? `${parentRel}/${String(entry.name)}` : String(entry.name);
      const fullKey = normPrefix && normPrefix !== "." ? `${normPrefix}/${relKey}` : relKey;
      keys.push(normalize(fullKey));
    }
  }
  keys.sort();
  return keys;
}

/** Resolved absolute path for a key (diagnostics only — never expose to clients). */
export function filePathForKey(key: string): string {
  assertKeySafe(key);
  return join(BASE_DIR, key);
}
