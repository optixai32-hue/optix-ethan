/**
 * Shared domain types — TypeScript port of the core SQLAlchemy models in
 * backend/onyx/db/models.py (Standard profile) and chat/models.py.
 * Column names match the original DB schema (snake_case) for data parity.
 * Task 2-a owns the DDL in db/migrations/versions.ts that matches these types.
 */

// ---------- Users / Auth (port of db/models.py: User, UserSession, ApiKey) ----------

export interface User {
  id: string; // uuid
  email: string;
  password_hash: string | null;
  role: "basic" | "admin" | "curator" | "global_curator";
  is_active: boolean;
  // db/models.py User.440-446 (personalization) + effective_permissions /
  // is_group_manager (group-derived permission cache, migration 0006).
  personal_name?: string | null;
  personal_role?: string | null;
  use_memories?: boolean;
  enable_memory_tool?: boolean;
  user_preferences?: string | null;
  effective_permissions?: string[];
  is_group_manager?: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface UserSession {
  id: string; // uuid
  user_id: string;
  created_at: Date;
  expires_at: Date;
}

export interface ApiKey {
  id: string; // uuid
  user_id: string;
  name: string;
  api_key_hash: string;
  api_key_display: string;
  is_active: boolean;
  created_at: Date;
}

// ---------- LLM providers (port of db/models.py: LlmProvider) ----------

export interface LlmProviderRow {
  id: number;
  name: string;
  provider: string; // e.g. "zai" | "openai-compatible"
  api_key: string | null;
  api_base: string | null;
  default_model_name: string | null;
  is_default: boolean;
  created_at: Date;
}

// ---------- Personas / Assistants (port of db/models.py: Persona) ----------

export interface Persona {
  id: number;
  name: string;
  description: string;
  system_prompt: string;
  llm_model_version_override: string | null;
  is_public: boolean;
  created_at: Date;
  updated_at: Date;
}

// ---------- Chat (port of db/models.py: ChatSession, ChatMessage + chat/models.py) ----------

export interface ChatSession {
  id: string; // uuid
  user_id: string;
  persona_id: number | null;
  title: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
  deleted: boolean;
}

export interface Citation {
  // Port of CitationInfo.citation_number (chat/streaming_models.py): the
  // [n] marker this citation answers to in the answer text.
  citation_number: number;
  document_id: string;
  semantic_identifier: string;
  link: string | null;
  blurb: string;
  source_type: string;
  chunk_id: number;
  score?: number | null;
}

export interface ChatMessage {
  id: number;
  chat_session_id: string;
  message: string;
  role: "user" | "assistant";
  message_index: number;
  // db/models.py ChatMessage.citations JSONB: dict[citation_number -> document_id]
  // (legacy array rows are still readable for backward compatibility).
  citations: Citation[] | Record<string, string> | null;
  error: string | null;
  created_at: Date;
  // Raw packet list of the turn (assistant messages only, migration 0014):
  // persisted so the history replay renders the exact live timeline
  // (Thinking -> Web Search -> Thinking -> answer -> Done). Null on legacy
  // rows and user messages.
  packets: unknown[] | null;
}

// ---------- Documents / Indexing (port of db/models.py: Document, Chunk) ----------

export interface DocumentRow {
  id: string; // connector doc id (semantic doc id)
  title: string;
  source_type: string;
  semantic_identifier: string;
  doc_updated_at: string | null;
  primary_owners: string[]; // text[]
  secondary_owners: string[]; // text[]
  metadata: Record<string, string | number>; // jsonb
  num_chunks: number;
  time_created: Date;
}

export interface ChunkRow {
  id: number; // serial, referenced by SearchDoc.chunk_id
  document_id: string;
  chunk_index: number; // position within doc
  content: string;
  blurb: string;
  /** Vector payloads live in the OpenSearch document index (knn_vector), mirroring
   *  Standard where Vespa holds embeddings; Postgres keeps relational chunk metadata. */
  embedding?: number[];
  doc_updated_at: string | null;
  metadata: Record<string, string | number>;
}

// ---------- Connectors (port of db/models.py: Connector, Credential, ConnectorCredentialPair) ----------

export interface Connector {
  id: number;
  name: string;
  source: string; // DocumentSource
  connector_specific_config: Record<string, unknown>;
  created_at: Date;
}

export interface Credential {
  id: number;
  name: string;
  credential_json: Record<string, unknown>;
  created_at: Date;
}

export interface CCPair {
  id: number;
  connector_id: number;
  credential_id: number;
  name: string;
  created_at: Date;
}

// ---------- Index attempts (port of db/models.py: IndexAttempt) ----------

export interface IndexAttempt {
  id: number;
  connector_id: number;
  cc_pair_id: number;
  status: "not_started" | "in_progress" | "completed" | "failed";
  total_docs: number;
  num_success: number;
  num_failed: number;
  error_msg: string | null;
  time_created: Date;
  time_updated: Date;
}

// ---------- Connector-side documents (port of connectors/models.py) ----------

export interface ConnectorDocSection {
  text: string;
  link?: string;
}

export interface ConnectorDoc {
  id: string;
  title: string;
  sections: ConnectorDocSection[];
  metadata?: Record<string, string | number>;
  doc_updated_at?: string;
}

export interface SlimDocMetadata {
  id: string;
  title: string;
  doc_updated_at?: string;
}

// ---------- Background tasks (celery-equivalent queue rows) ----------

export interface TaskRow {
  id: number;
  type: string;
  args: string; // JSON payload
  status: "queued" | "running" | "complete" | "failed";
  priority: number;
  attempts: number;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RecurringTaskRow {
  id: number;
  name: string;
  task_type: string;
  cron: string; // 5-field cron
  payload: string; // JSON
  last_run_at: Date | null;
  enabled: boolean;
}

// ---------- Craft / artifacts ----------

export interface Artifact {
  id: string;
  chat_session_id: string | null;
  title: string;
  content: string;
  created_at: Date;
  updated_at: Date;
}

// ---------- Search results (port of SearchDoc) ----------

export interface SearchDoc {
  chunk_id: number;
  document_id: string;
  chunk_ind: number;
  semantic_identifier: string;
  title: string;
  blurb: string;
  content: string;
  source_type: string;
  metadata: Record<string, string | number>;
  primary_owners: string[];
  secondary_owners: string[];
  doc_updated_at: string | null;
  score: number | null;
  /** Web/document link when the connector supplies one (web connector doc URL). */
  link?: string | null;
}

// ---------- Auth context ----------

export interface AuthContext {
  user: User;
  viaApiKey: boolean;
}
