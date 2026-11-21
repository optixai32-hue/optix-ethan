/**
 * Central configuration — port of backend/onyx/configs/constants.py (Standard profile).
 * Standard mode ONLY: real Postgres + real document index + redis-compatible cache.
 * Lite-mode variables (DISABLE_VECTOR_DB, CACHE_BACKEND=postgres) are intentionally ABSENT.
 */

export const API_PORT = Number(process.env.ONYX_API_PORT ?? 8080);

// Postgres (relational DB of Standard; running instance from the standard-mode stack)
// Fallback chain: ONYX_POSTGRES_URI -> DATABASE_URL. The DATABASE_URL fallback
// powers the single-deployment Vercel build (web + backend in one Next.js
// project), where the shared env carries the managed (Supabase) DSN under the
// DATABASE_URL name and no ONYX_POSTGRES_URI exists.
export const POSTGRES_URI =
  process.env.ONYX_POSTGRES_URI?.trim() ||
  process.env.DATABASE_URL?.trim() ||
  "";

// Shared hosted Postgres (Supavisor/Neon pooler) detection. A pooled shared
// DB is isolated into the dedicated "onyx" schema (same convention the
// nelth-ai-api serverless deployment used via ONYX_DB_SCHEMA) so the onyx
// tables never collide with the host database's own tables.
export const IS_SHARED_HOSTED_DB =
  /pooler\.(supabase|neon)\.com|\.supabase\.co|neon\.tech/.test(POSTGRES_URI);
export const DB_SCHEMA =
  process.env.ONYX_DB_SCHEMA?.trim() || (IS_SHARED_HOSTED_DB ? "onyx" : "");

// Serverless / shared-DB profile (migrations skip session advisory locks):
// ONYX_SERVERLESS, or a dedicated schema on a shared hosted DB, or any Vercel
// runtime. Mirrors the detection the nelth-ai-api deployment relied on.
export const IS_SERVERLESS_SHARED_DB = Boolean(
  DB_SCHEMA ||
    process.env.ONYX_SERVERLESS?.trim() ||
    process.env.VERCEL_URL ||
    process.env.VERCEL === "1",
);

// Redis (cache layer of Standard — real Redis at 127.0.0.1:6379)
export const REDIS_URL = process.env.ONYX_REDIS_URL?.trim() || "";
export const REDIS_KEY_PREFIX = "onyx_ts:";

// OpenSearch (document index of Standard — real OpenSearch at 127.0.0.1:9200)
export const OPENSEARCH_HOST =
  process.env.ONYX_OPENSEARCH_HOST?.trim() || "http://127.0.0.1:9200";
export const OPENSEARCH_USERNAME = process.env.ONYX_OPENSEARCH_USERNAME ?? "admin";
export const OPENSEARCH_PASSWORD = process.env.ONYX_OPENSEARCH_PASSWORD ?? "StrongPassword123!";

// Embedding settings (indexing_model_server boundary)
export const INDEXING_EMBEDDING_MODEL =
  process.env.ONYX_EMBEDDING_MODEL ?? "onyx-ts-local-embedder";
export const INDEXING_EMBEDDING_DIM = Number(process.env.ONYX_EMBEDDING_DIM ?? 384);
export const INDEXING_BATCH_SIZE = Number(process.env.ONYX_INDEXING_BATCH_SIZE ?? 32);

// Chunking (port of Onyx chunking settings)
export const DEFAULT_CHUNK_SIZE = Number(process.env.ONYX_CHUNK_SIZE ?? 512); // tokens
export const DEFAULT_CHUNK_OVERLAP = Number(process.env.ONYX_CHUNK_OVERLAP ?? 76); // tokens
export const CHUNK_MAX_TOKENS_HARD = DEFAULT_CHUNK_SIZE + 100;

// LLM (inference_model_server boundary)
// OpenAI-compatible surface. On single-deployment Vercel builds the KILO
// gateway envs (present on the shared web project) act as fallbacks so chat
// works without any ONYX_OPENAI_* variables being set.
export const OPENAI_API_BASE =
  process.env.ONYX_OPENAI_API_BASE?.trim() ||
  process.env.KILO_GATEWAY_BASE_URL?.trim() ||
  "";
export const OPENAI_API_KEY =
  process.env.ONYX_OPENAI_API_KEY?.trim() ||
  process.env.KILO_GATEWAY_API_KEY?.trim() ||
  null;
export const OPENAI_MODEL =
  process.env.ONYX_OPENAI_MODEL?.trim() ||
  process.env.ONYX_STRONG_MODEL?.trim() ||
  process.env.DEFAULT_MODELS?.trim() ||
  "default";

// Default provider when no explicit providerId is given: on Vercel runtimes
// (no z-ai config file) route to the OpenAI-compatible gateway, elsewhere
// keep the sandbox z.ai provider.
export const DEFAULT_LLM_PROVIDER =
  process.env.ONYX_LLM_PROVIDER?.trim() ||
  (process.env.VERCEL_URL || process.env.VERCEL === "1" || (OPENAI_API_BASE && OPENAI_API_KEY)
    ? "openai-compatible"
    : "zai");
export const DEFAULT_FAST_MODEL =
  process.env.ONYX_FAST_MODEL?.trim() ||
  process.env.DEFAULT_MODELS?.trim() ||
  "default";
export const DEFAULT_STRONG_MODEL =
  process.env.ONYX_STRONG_MODEL?.trim() ||
  process.env.DEFAULT_MODELS?.trim() ||
  "default";

// Auth
// Port of onyx/auth/session_tokens.py FASTAPI_USERS_AUTH_COOKIE_NAME — the
// original web frontend reads this exact cookie name (SERVER_SIDE_ONLY__AUTH_COOKIE_NAME).
export const SESSION_COOKIE_NAME = "fastapiusersauth";
export const SESSION_EXPIRY_HOURS = Number(process.env.ONYX_SESSION_EXPIRY_HOURS ?? 24 * 14);
export const DEFAULT_ADMIN_EMAIL = process.env.ONYX_ADMIN_EMAIL ?? "admin@onyx-ts.local";
export const DEFAULT_ADMIN_PASSWORD = process.env.ONYX_ADMIN_PASSWORD ?? "admin";

/**
 * Port of the effective security/auth configuration served by
 * GET /auth/type (backend/onyx/server/manage/get_state.py get_auth_type):
 *   - MULTI_TENANT, REQUIRE_EMAIL_VERIFICATION, OAUTH_ENABLED,
 *     ANONYMOUS_USER_ENABLED (onyx/configs/app_configs.py)
 *   - SecuritySettings env defaults (onyx/server/security/store.py
 *     _build_env_defaults -> onyx/configs/app_configs.py PASSWORD_* values)
 */
export const AUTH_CONFIG = {
  multiTenant: process.env.MULTI_TENANT?.toLowerCase() === "true",
  requiresVerification:
    process.env.REQUIRE_EMAIL_VERIFICATION?.toLowerCase() === "true",
  anonymousUserEnabled:
    process.env.ANONYMOUS_USER_ENABLED?.toLowerCase() === "true",
  oauthEnabled: process.env.OAUTH_ENABLED?.toLowerCase() === "true",
  passwordMinLength: Number(process.env.PASSWORD_MIN_LENGTH ?? 8),
  passwordMaxLength: Number(process.env.PASSWORD_MAX_LENGTH ?? 64),
  passwordRequireUppercase:
    process.env.PASSWORD_REQUIRE_UPPERCASE?.toLowerCase() === "true",
  passwordRequireLowercase:
    process.env.PASSWORD_REQUIRE_LOWERCASE?.toLowerCase() === "true",
  passwordRequireDigit:
    process.env.PASSWORD_REQUIRE_DIGIT?.toLowerCase() === "true",
  passwordRequireSpecialChar:
    process.env.PASSWORD_REQUIRE_SPECIAL_CHAR?.toLowerCase() === "true",
  passwordAuthEnabled: true,
} as const;

/**
 * Port of server/settings defaults used by GET /settings (UserSettings):
 *   MAX_ALLOWED_UPLOAD_SIZE_MB, DEFAULT_USER_FILE_MAX_UPLOAD_SIZE_MB,
 *   DEFAULT_FILE_TOKEN_COUNT_THRESHOLD_K_VECTOR_DB (server/settings/models.py),
 *   DEFAULT_PRUNING_FREQ (7 days), DEFAULT_REFRESH_FREQ (30 min) — app_configs.py
 */
export const SETTINGS_DEFAULTS = {
  maxAllowedUploadSizeMb: Number(process.env.MAX_ALLOWED_UPLOAD_SIZE_MB ?? 250),
  defaultUserFileMaxUploadSizeMb: Number(
    process.env.DEFAULT_USER_FILE_MAX_UPLOAD_SIZE_MB ?? 100,
  ),
  defaultFileTokenCountThresholdK: 200,
  defaultPruningFreq: 60 * 60 * 24 * 7, // 7 days, in seconds
  defaultRefreshFreq: 60 * 30, // 30 minutes, in seconds
  defaultEmbeddingRateLimitPeriodSeconds: 60,
  postgresDefaultSchema: "public",
  backendVersion: process.env.ONYX_VERSION || "v5.1.0-cloud.1",
} as const;

// Storage / file store
export const FILE_STORE_DIR = process.env.ONYX_FILE_STORE_DIR ?? "/tmp/onyx-ts-file-store";

// Background worker
export const WORKER_POLL_INTERVAL_MS = Number(process.env.ONYX_WORKER_POLL_MS ?? 1000);
export const WORKER_CONCURRENCY = Number(process.env.ONYX_WORKER_CONCURRENCY ?? 4);
export const SCHEDULER_INTERVAL_MS = Number(process.env.ONYX_SCHEDULER_POLL_MS ?? 15_000);

// Retrieval defaults (port of search settings)
export const DEFAULT_NUM_RETRIEVED_DOCS = 10;
export const DEFAULT_MAX_FUZZY_RESULTS = 10;
export const RRF_K = 60; // reciprocal rank fusion constant, matches Standard's fusion behavior
export const ENABLE_LLM_RERANK_DEFAULT = false;

// SearchDoc source types (port of enums like connectors/index/enums.py DocumentSource)
export const VALID_SOURCE_TYPES = [
  "ingest_document", "web", "file", "google_drive", "slack", "github",
  "notion", "confluence", "jira", "linear", "not_implemented",
] as const;
export type DocumentSource = (typeof VALID_SOURCE_TYPES)[number];

export function requirePostgresUri(): string {
  if (!POSTGRES_URI) {
    throw new Error(
      "No Postgres DSN: set ONYX_POSTGRES_URI (or DATABASE_URL for the single-deployment Vercel build).",
    );
  }
  return POSTGRES_URI;
}
