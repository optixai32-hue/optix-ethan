/**
 * API key generation/validation — TypeScript port of:
 *   - /home/z/onyx/backend/onyx/auth/api_key.py
 *       generate_api_key (prefix + token_urlsafe entropy), hash_api_key
 *       (UNSALTED sha256 hexdigest — "no salt is needed, as the API key is
 *       randomly generated and overlaps are impossible"),
 *       build_displayable_api_key (prefix + leading secret chars + mask)
 *   - /home/z/onyx/backend/onyx/auth/constants.py
 *       API_KEY_PREFIX ("on_"), API_KEY_LENGTH
 *   - /home/z/onyx/backend/onyx/db/api_key.py
 *       insert_api_key, fetch_api_keys / fetch_api_key_auth_result
 *       (join ApiKey -> User on hash match), remove_api_key
 *
 * Deviations (documented in PORT_REPORT): key prefix is "onyx_ts_" (this port's
 * namespace) instead of "on_", entropy is 32 hex chars instead of
 * token_urlsafe(192), and api_key_display is prefix + first 8 secret chars + "...".
 * Storage shape matches the original: only the sha256 hash is persisted; the full
 * key is returned exactly once on creation (ApiKeyDescriptor.api_key).
 */
import { createHash, randomBytes } from "node:crypto";
import { query, queryOne } from "../db/client";
import { rowToApiKey, rowToUser } from "../db/models/rows";
import { getLogger } from "../utils/logger";
import { NotFoundError } from "../utils/errors";
import type { ApiKey, AuthContext } from "../types/domain";

const logger = getLogger("auth.api_keys");

/** Port of onyx/auth/constants.py API_KEY_PREFIX (renamed for this deployment). */
export const API_KEY_PREFIX = "onyx_ts_";
/** 32 hex chars of entropy (16 random bytes), replacing token_urlsafe(API_KEY_LENGTH). */
const API_KEY_SECRET_BYTES = 16;

/** Port of generate_api_key: `onyx_ts_<32 hex>`; the full key is shown only here. */
export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(API_KEY_SECRET_BYTES).toString("hex");
}

/**
 * Port of hash_api_key: plain sha256 hexdigest with no salt (the key is random).
 * Raises on an invalid prefix, exactly like the Python ValueError.
 */
export function hashApiKey(apiKey: string): string {
  if (!apiKey.startsWith(API_KEY_PREFIX)) {
    throw new Error(`Invalid API key prefix: ${apiKey.slice(0, 3)}`);
  }
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

/** Port of build_displayable_api_key: keep the prefix + first 8 secret chars + "...". */
export function buildDisplayableApiKey(apiKey: string): string {
  const secret = apiKey.startsWith(API_KEY_PREFIX) ? apiKey.slice(API_KEY_PREFIX.length) : apiKey;
  return `${API_KEY_PREFIX}${secret.slice(0, 8)}...`;
}

export interface CreatedApiKey {
  /** DB row (hash + display only — never the raw key). */
  apiKey: ApiKey;
  /** Port of ApiKeyDescriptor.api_key: present only on initial creation. */
  key: string;
}

/** Port of db/api_key.py insert_api_key (scoped to the calling user; no service-account synthetic user). */
export async function createApiKey(userId: string, name: string): Promise<CreatedApiKey> {
  const key = generateApiKey();
  const hashed = hashApiKey(key);
  const display = buildDisplayableApiKey(key);
  const row = await queryOne<Record<string, unknown>>(
    `INSERT INTO api_key (user_id, name, api_key_hash, api_key_display)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [userId, name, hashed, display],
  );
  if (!row) {
    throw new Error("Failed to create API key");
  }
  logger.info("created api key", { user_id: userId, name });
  return { apiKey: rowToApiKey(row), key };
}

/** Port of db/api_key.py fetch_api_keys, scoped to the owning user. */
export async function listApiKeys(userId: string): Promise<ApiKey[]> {
  const res = await query<Record<string, unknown>>(
    `SELECT * FROM api_key WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return res.rows.map(rowToApiKey);
}

/** Port of db/api_key.py remove_api_key (ownership-scoped). Returns false if absent. */
export async function deleteApiKey(apiKeyId: string, userId: string): Promise<boolean> {
  const res = await query<{ id: string }>(
    `DELETE FROM api_key WHERE id = $1 AND user_id = $2 RETURNING id`,
    [apiKeyId, userId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Port of db/api_key.py fetch_api_key_auth_result: hash-lookup join onto the active user. */
export async function authenticateApiKey(apiKey: string): Promise<AuthContext | null> {
  if (!apiKey.startsWith(API_KEY_PREFIX)) {
    // port of hash_api_key's invalid-prefix ValueError, surfaced as auth failure
    return null;
  }
  const hashed = hashApiKey(apiKey);
  const row = await queryOne<Record<string, unknown>>(
    `SELECT u.*
     FROM api_key k
     JOIN onyx_user u ON u.id = k.user_id
     WHERE k.api_key_hash = $1 AND k.is_active = true AND u.is_active = true
     LIMIT 1`,
    [hashed],
  );
  if (!row) return null;
  return { user: rowToUser(row), viaApiKey: true };
}

/** Admin-side delete (no ownership check) — port of remove_api_key's admin path. */
export async function deleteApiKeyAdmin(apiKeyId: string): Promise<void> {
  const res = await query<{ id: string }>(
    `DELETE FROM api_key WHERE id = $1 RETURNING id`,
    [apiKeyId],
  );
  if ((res.rowCount ?? 0) === 0) {
    throw new NotFoundError("API key");
  }
}
