/**
 * Row mappers — pg result rows -> src/types/domain.ts interfaces.
 *
 * Companion to the DDL in db/migrations/versions.ts, which ports the SQLAlchemy
 * models in /home/z/onyx/backend/onyx/db/models.py (User, ApiKey, Persona,
 * ChatSession, ChatMessage, Connector, Credential, ConnectorCredentialPair,
 * IndexAttempt, Document, LLMProvider) and /home/z/onyx/backend/onyx/db/chunk.py.
 *
 * node-pg already parses: timestamptz -> Date, jsonb -> object, text[] -> string[],
 * int4 -> number. int8 (bigserial) arrives as a string, so numeric coercion is
 * tolerant of numeric strings. jsonb "payload" columns map to JSON strings where
 * the domain type says string (TaskRow.args, RecurringTaskRow.payload), matching
 * the JSON-serialized task payloads celery carried.
 */
import type {
  ApiKey,
  Artifact,
  CCPair,
  ChatMessage,
  ChatSession,
  ChunkRow,
  Citation,
  Connector,
  Credential,
  DocumentRow,
  IndexAttempt,
  LlmProviderRow,
  Persona,
  RecurringTaskRow,
  TaskRow,
  User,
  UserSession,
} from "../../types/domain";

type Row = Record<string, unknown>;

// ---------- primitive coercion helpers ----------

function reqStr(row: Row, key: string): string {
  const v = row[key];
  if (typeof v === "string") return v;
  throw new TypeError(`row mapper: column '${key}' expected string, got ${typeof v}`);
}

function optStr(row: Row, key: string): string | null {
  const v = row[key];
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  throw new TypeError(`row mapper: column '${key}' expected string|null, got ${typeof v}`);
}

function reqNum(row: Row, key: string): number {
  const v = row[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  // int8 columns (bigserial) come back as strings from node-pg
  if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
  throw new TypeError(`row mapper: column '${key}' expected number, got ${typeof v}`);
}

function reqBool(row: Row, key: string): boolean {
  const v = row[key];
  if (typeof v === "boolean") return v;
  throw new TypeError(`row mapper: column '${key}' expected boolean, got ${typeof v}`);
}

function optBool(row: Row, key: string, fallback: boolean): boolean {
  const v = row[key];
  if (v === null || v === undefined) return fallback;
  if (typeof v === "boolean") return v;
  throw new TypeError(`row mapper: column '${key}' expected boolean|null, got ${typeof v}`);
}

function reqDate(row: Row, key: string): Date {
  const v = row[key];
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v;
  throw new TypeError(`row mapper: column '${key}' expected Date, got ${typeof v}`);
}

function optDate(row: Row, key: string): Date | null {
  const v = row[key];
  if (v === null || v === undefined) return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v;
  throw new TypeError(`row mapper: column '${key}' expected Date|null, got ${typeof v}`);
}

function reqObj(row: Row, key: string): Record<string, unknown> {
  const v = row[key];
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  // jsonb can also arrive as text in exotic drivers; parse defensively
  if (typeof v === "string") {
    const parsed: unknown = JSON.parse(v);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  return {};
}

/** jsonb column that the domain type models as a serialized JSON string. */
function jsonAsString(row: Row, key: string): string {
  const v = row[key];
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "{}";
  if (typeof v === "object") return JSON.stringify(v);
  throw new TypeError(`row mapper: column '${key}' expected jsonb, got ${typeof v}`);
}

/** str[] column (text[]) with '{}' default. */
function strArray(row: Row, key: string): string[] {
  const v = row[key];
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) {
    return v.filter((item): item is string => typeof item === "string");
  }
  throw new TypeError(`row mapper: column '${key}' expected string[], got ${typeof v}`);
}

/** jsonb Record<string, string | number> — non-scalar entries are stringified. */
function scalarRecord(row: Row, key: string): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(reqObj(row, key))) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "string") out[k] = v;
    else if (v !== null && typeof v !== "object") out[k] = String(v);
    // nested objects/arrays are not representable in the domain type; skipped
  }
  return out;
}

function narrowEnum<T extends string>(value: unknown, allowed: readonly T[], column: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new TypeError(
    `row mapper: column '${column}' expected one of [${allowed.join(", ")}], got ${String(value)}`,
  );
}

// ---------- domain-specific narrowing ----------

const USER_ROLES = ["basic", "admin", "curator", "global_curator"] as const;
const MESSAGE_ROLES = ["user", "assistant"] as const;
const INDEX_ATTEMPT_STATUSES = ["not_started", "in_progress", "completed", "failed"] as const;
const TASK_STATUSES = ["queued", "running", "complete", "failed"] as const;

function narrowCitations(value: unknown): Citation[] | Record<string, string> | null {
  if (value === null || value === undefined) return null;
  // dict[citation_number -> document_id] (db/models.py ChatMessage.citations)
  if (!Array.isArray(value) && typeof value === "object") {
    const dict: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string") dict[k] = v;
    }
    return dict;
  }
  if (!Array.isArray(value)) return null;
  const out: Citation[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.document_id !== "string") continue;
    out.push({
      citation_number: typeof obj.citation_number === "number" ? obj.citation_number : 0,
      document_id: obj.document_id,
      semantic_identifier: typeof obj.semantic_identifier === "string" ? obj.semantic_identifier : "",
      link: typeof obj.link === "string" ? obj.link : null,
      blurb: typeof obj.blurb === "string" ? obj.blurb : "",
      source_type: typeof obj.source_type === "string" ? obj.source_type : "",
      chunk_id: typeof obj.chunk_id === "number" ? obj.chunk_id : Number(obj.chunk_id ?? 0),
      score: typeof obj.score === "number" ? obj.score : null,
    });
  }
  return out;
}

// ---------- mappers (rowToX, per PORT_MAP naming) ----------

/** Port of models.py User (+ fastapi_users base columns). */
export function rowToUser(row: Row): User {
  return {
    id: reqStr(row, "id"),
    email: reqStr(row, "email"),
    password_hash: optStr(row, "password_hash"),
    role: narrowEnum(row["role"], USER_ROLES, "role"),
    is_active: reqBool(row, "is_active"),
    personal_name: optStr(row, "personal_name"),
    personal_role: optStr(row, "personal_role"),
    use_memories: row["use_memories"] === null || row["use_memories"] === undefined ? undefined : Boolean(row["use_memories"]),
    enable_memory_tool: row["enable_memory_tool"] === null || row["enable_memory_tool"] === undefined ? undefined : Boolean(row["enable_memory_tool"]),
    user_preferences: optStr(row, "user_preferences"),
    effective_permissions: Array.isArray(row["effective_permissions"])
      ? (row["effective_permissions"] as string[])
      : [],
    is_group_manager: row["is_group_manager"] === null || row["is_group_manager"] === undefined ? undefined : Boolean(row["is_group_manager"]),
    created_at: reqDate(row, "created_at"),
    updated_at: reqDate(row, "updated_at"),
  };
}

export function rowToUserSession(row: Row): UserSession {
  return {
    id: reqStr(row, "id"),
    user_id: reqStr(row, "user_id"),
    created_at: reqDate(row, "created_at"),
    expires_at: reqDate(row, "expires_at"),
  };
}

/** Port of models.py ApiKey (hashed_api_key -> api_key_hash per Standard schema naming). */
export function rowToApiKey(row: Row): ApiKey {
  return {
    id: reqStr(row, "id"),
    user_id: reqStr(row, "user_id"),
    name: reqStr(row, "name"),
    api_key_hash: reqStr(row, "api_key_hash"),
    api_key_display: reqStr(row, "api_key_display"),
    is_active: optBool(row, "is_active", true),
    created_at: reqDate(row, "created_at"),
  };
}

/** Port of models.py LLMProvider. */
export function rowToLlmProvider(row: Row): LlmProviderRow {
  return {
    id: reqNum(row, "id"),
    name: reqStr(row, "name"),
    provider: reqStr(row, "provider"),
    api_key: optStr(row, "api_key"),
    api_base: optStr(row, "api_base"),
    default_model_name: optStr(row, "default_model_name"),
    is_default: optBool(row, "is_default", false),
    created_at: reqDate(row, "created_at"),
  };
}

/** Port of models.py Persona. */
export function rowToPersona(row: Row): Persona {
  return {
    id: reqNum(row, "id"),
    name: reqStr(row, "name"),
    description: optStr(row, "description") ?? "",
    system_prompt: optStr(row, "system_prompt") ?? "",
    llm_model_version_override: optStr(row, "llm_model_version_override"),
    is_public: reqBool(row, "is_public"),
    created_at: reqDate(row, "created_at"),
    updated_at: reqDate(row, "updated_at"),
  };
}

/** Port of models.py ChatSession. */
export function rowToChatSession(row: Row): ChatSession {
  return {
    id: reqStr(row, "id"),
    user_id: reqStr(row, "user_id"),
    persona_id: row["persona_id"] === null || row["persona_id"] === undefined ? null : reqNum(row, "persona_id"),
    title: optStr(row, "title") ?? "New chat",
    description: optStr(row, "description"),
    created_at: reqDate(row, "created_at"),
    updated_at: reqDate(row, "updated_at"),
    deleted: reqBool(row, "deleted"),
  };
}

/** Port of models.py ChatMessage (citations jsonb -> Citation[]). */
export function rowToChatMessage(row: Row): ChatMessage {
  return {
    id: reqNum(row, "id"),
    chat_session_id: reqStr(row, "chat_session_id"),
    message: reqStr(row, "message"),
    role: narrowEnum(row["role"], MESSAGE_ROLES, "role"),
    message_index: reqNum(row, "message_index"),
    citations: narrowCitations(row["citations"]),
    error: optStr(row, "error"),
    created_at: reqDate(row, "created_at"),
    packets: Array.isArray(row["packets"])
      ? (row["packets"] as unknown[])
      : null,
  };
}

/** Port of models.py Connector. */
export function rowToConnector(row: Row): Connector {
  return {
    id: reqNum(row, "id"),
    name: reqStr(row, "name"),
    source: reqStr(row, "source"),
    connector_specific_config: reqObj(row, "connector_specific_config"),
    created_at: reqDate(row, "created_at"),
  };
}

/** Port of models.py Credential. */
export function rowToCredential(row: Row): Credential {
  return {
    id: reqNum(row, "id"),
    name: reqStr(row, "name"),
    credential_json: reqObj(row, "credential_json"),
    created_at: reqDate(row, "created_at"),
  };
}

/** Port of models.py ConnectorCredentialPair. */
export function rowToCCPair(row: Row): CCPair {
  return {
    id: reqNum(row, "id"),
    connector_id: reqNum(row, "connector_id"),
    credential_id: reqNum(row, "credential_id"),
    name: reqStr(row, "name"),
    created_at: reqDate(row, "created_at"),
  };
}

/** Port of models.py IndexAttempt (subset of columns kept in this port). */
export function rowToIndexAttempt(row: Row): IndexAttempt {
  return {
    id: reqNum(row, "id"),
    connector_id: reqNum(row, "connector_id"),
    cc_pair_id: reqNum(row, "cc_pair_id"),
    status: narrowEnum(row["status"], INDEX_ATTEMPT_STATUSES, "status"),
    total_docs: row["total_docs"] === null || row["total_docs"] === undefined ? 0 : reqNum(row, "total_docs"),
    num_success: row["num_success"] === null || row["num_success"] === undefined ? 0 : reqNum(row, "num_success"),
    num_failed: row["num_failed"] === null || row["num_failed"] === undefined ? 0 : reqNum(row, "num_failed"),
    error_msg: optStr(row, "error_msg"),
    time_created: reqDate(row, "time_created"),
    time_updated: reqDate(row, "time_updated"),
  };
}

/** Port of models.py Document (relational columns; vectors live in OpenSearch). */
export function rowToDocument(row: Row): DocumentRow {
  return {
    id: reqStr(row, "id"),
    title: reqStr(row, "title"),
    source_type: reqStr(row, "source_type"),
    semantic_identifier: reqStr(row, "semantic_identifier"),
    doc_updated_at: optStr(row, "doc_updated_at"),
    primary_owners: strArray(row, "primary_owners"),
    secondary_owners: strArray(row, "secondary_owners"),
    metadata: scalarRecord(row, "metadata"),
    num_chunks: reqNum(row, "num_chunks"),
    time_created: reqDate(row, "time_created"),
  };
}

/** Port of db/chunk.py relational chunk metadata. */
export function rowToChunk(row: Row): ChunkRow {
  return {
    id: reqNum(row, "id"),
    document_id: reqStr(row, "document_id"),
    chunk_index: reqNum(row, "chunk_index"),
    content: reqStr(row, "content"),
    blurb: optStr(row, "blurb") ?? "",
    doc_updated_at: optStr(row, "doc_updated_at"),
    metadata: scalarRecord(row, "metadata"),
  };
}

/** Task-queue row (celery equivalent; args jsonb -> JSON string). */
export function rowToTask(row: Row): TaskRow {
  return {
    id: reqNum(row, "id"),
    type: reqStr(row, "type"),
    args: jsonAsString(row, "args"),
    status: narrowEnum(row["status"], TASK_STATUSES, "status"),
    priority: reqNum(row, "priority"),
    attempts: reqNum(row, "attempts"),
    error: optStr(row, "error"),
    created_at: reqDate(row, "created_at"),
    updated_at: reqDate(row, "updated_at"),
  };
}

export function rowToRecurringTask(row: Row): RecurringTaskRow {
  return {
    id: reqNum(row, "id"),
    name: reqStr(row, "name"),
    task_type: reqStr(row, "task_type"),
    cron: reqStr(row, "cron"),
    payload: jsonAsString(row, "payload"),
    last_run_at: optDate(row, "last_run_at"),
    enabled: reqBool(row, "enabled"),
  };
}

/** Port of models.py Artifact (chat-scoped in this port). */
export function rowToArtifact(row: Row): Artifact {
  return {
    id: reqStr(row, "id"),
    chat_session_id: optStr(row, "chat_session_id"),
    title: reqStr(row, "title"),
    content: optStr(row, "content") ?? "",
    created_at: reqDate(row, "created_at"),
    updated_at: reqDate(row, "updated_at"),
  };
}
