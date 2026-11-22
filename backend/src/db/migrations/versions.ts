/**
 * Ordered migration SQL — TypeScript port of the Onyx Standard relational schema.
 *
 * Python sources this DDL was ported from (read for column names/types/defaults):
 *   - /home/z/onyx/backend/onyx/db/models.py
 *       User (line 428), ApiKey (658), ConnectorCredentialPair (1001), Document (1262),
 *       Connector (2035), Credential (2112), IndexAttempt (2658), ChatSession (3449),
 *       ChatMessage (3726), LLMProvider (4346), Persona (4888), Artifact (8183)
 *   - /home/z/onyx/backend/onyx/db/users.py, /home/z/onyx/backend/onyx/db/auth.py (user/session tables)
 *   - /home/z/onyx/backend/onyx/auth/api_key.py + /home/z/onyx/backend/onyx/db/api_key.py (api_key table)
 *   - /home/z/onyx/backend/onyx/db/chunk.py + indexing pipeline (chunk relational metadata)
 *   - /home/z/onyx/backend/onyx/db/tasks.py (celery queue rows -> task_queue)
 *   - /home/z/onyx/backend/onyx/db/persona.py + /home/z/onyx/backend/onyx/prompts/chat_prompts.py
 *     (DEFAULT_SYSTEM_PROMPT, seeded Default Assistant persona)
 *
 * Column names are snake_case and MUST match src/types/domain.ts interfaces.
 * Onyx Lite is out of scope: no DISABLE_VECTOR_DB / CACHE_BACKEND=postgres concepts here.
 */
import type { MigrationVersion } from "./runner.js";

const INITIAL_STANDARD_SCHEMA = `
-- gen_random_uuid() is a core PostgreSQL 13+ function (no pgcrypto needed).

-- ---------- Users / Auth (port of models.py: User, UserSession, ApiKey) ----------
CREATE TABLE IF NOT EXISTS onyx_user (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NULL,
  role          TEXT NOT NULL DEFAULT 'basic',
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_session (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES onyx_user(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS api_key (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID REFERENCES onyx_user(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  api_key_hash   TEXT NOT NULL UNIQUE,
  api_key_display TEXT NOT NULL,
  is_active      BOOLEAN DEFAULT true,
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- ---------- LLM providers (port of models.py: LLMProvider) ----------
CREATE TABLE IF NOT EXISTS llm_provider (
  id                 SERIAL PRIMARY KEY,
  name               TEXT NOT NULL,
  provider           TEXT NOT NULL,
  api_key            TEXT NULL,
  api_base           TEXT NULL,
  default_model_name TEXT NULL,
  is_default         BOOLEAN DEFAULT false,
  created_at         TIMESTAMPTZ DEFAULT now()
);

-- ---------- Personas / Assistants (port of models.py: Persona) ----------
CREATE TABLE IF NOT EXISTS persona (
  id                        SERIAL PRIMARY KEY,
  name                      TEXT NOT NULL,
  description               TEXT NOT NULL DEFAULT '',
  system_prompt             TEXT NOT NULL DEFAULT '',
  llm_model_version_override TEXT NULL,
  is_public                 BOOLEAN NOT NULL DEFAULT true,
  created_at                TIMESTAMPTZ DEFAULT now(),
  updated_at                TIMESTAMPTZ DEFAULT now()
);

-- ---------- Chat (port of models.py: ChatSession, ChatMessage) ----------
CREATE TABLE IF NOT EXISTS chat_session (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES onyx_user(id),
  persona_id  INTEGER REFERENCES persona(id),
  title       TEXT NOT NULL DEFAULT 'New chat',
  description TEXT NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  deleted     BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS chat_message (
  id              SERIAL PRIMARY KEY,
  chat_session_id UUID REFERENCES chat_session(id) ON DELETE CASCADE,
  message         TEXT NOT NULL,
  role            TEXT NOT NULL,
  message_index   INTEGER NOT NULL,
  citations       JSONB NULL,
  error           TEXT NULL,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- ---------- Connectors (port of models.py: Connector, Credential, ConnectorCredentialPair) ----------
CREATE TABLE IF NOT EXISTS connector (
  id                        SERIAL PRIMARY KEY,
  name                      TEXT NOT NULL,
  source                    TEXT NOT NULL,
  connector_specific_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credential (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  credential_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS connector_credential_pair (
  id            SERIAL PRIMARY KEY,
  connector_id  INTEGER REFERENCES connector(id) ON DELETE CASCADE,
  credential_id INTEGER REFERENCES credential(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- ---------- Index attempts (port of models.py: IndexAttempt) ----------
CREATE TABLE IF NOT EXISTS index_attempt (
  id           SERIAL PRIMARY KEY,
  connector_id INTEGER NOT NULL,
  cc_pair_id   INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'not_started',
  total_docs   INTEGER DEFAULT 0,
  num_success  INTEGER DEFAULT 0,
  num_failed   INTEGER DEFAULT 0,
  error_msg    TEXT NULL,
  time_created TIMESTAMPTZ DEFAULT now(),
  time_updated TIMESTAMPTZ DEFAULT now()
);

-- ---------- Documents / Chunks (port of models.py: Document + db/chunk.py) ----------
-- doc_updated_at is TEXT here (ISO-8601 string as produced by connectors), matching
-- the DocumentRow/ChunkRow domain types; embeddings live in OpenSearch, Postgres
-- keeps the relational chunk metadata (Standard boundary: Vespa holds vectors).
CREATE TABLE IF NOT EXISTS document (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  source_type         TEXT NOT NULL,
  semantic_identifier TEXT NOT NULL,
  doc_updated_at      TEXT NULL,
  primary_owners      TEXT[] DEFAULT '{}',
  secondary_owners    TEXT[] DEFAULT '{}',
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  num_chunks          INTEGER NOT NULL DEFAULT 0,
  time_created        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunk (
  id             BIGSERIAL PRIMARY KEY,
  document_id    TEXT REFERENCES document(id) ON DELETE CASCADE,
  chunk_index    INTEGER NOT NULL,
  content        TEXT NOT NULL,
  blurb          TEXT NOT NULL DEFAULT '',
  doc_updated_at TEXT NULL,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (document_id, chunk_index)
);

-- ---------- Background tasks (celery-equivalent DB-backed queue) ----------
CREATE TABLE IF NOT EXISTS task_queue (
  id         BIGSERIAL PRIMARY KEY,
  type       TEXT NOT NULL,
  args       JSONB NOT NULL DEFAULT '{}'::jsonb,
  status     TEXT NOT NULL DEFAULT 'queued',
  priority   INTEGER NOT NULL DEFAULT 0,
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recurring_task (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  task_type   TEXT NOT NULL,
  cron        TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_run_at TIMESTAMPTZ NULL,
  enabled     BOOLEAN NOT NULL DEFAULT true
);

-- ---------- Craft / artifacts (port of models.py: Artifact) ----------
CREATE TABLE IF NOT EXISTS artifact (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_session_id UUID NULL,
  title           TEXT NOT NULL,
  content         TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- ---------- Indexes (mirrors hot paths of the SQLAlchemy __table_args__) ----------
-- chat_session(user_id): sidebar query, mirrors ix_chat_session_user_id_onyxbot_flow_time_updated
CREATE INDEX IF NOT EXISTS ix_chat_session_user_id ON chat_session (user_id);
-- chat_message(chat_session_id, message_index): history replay,
-- mirrors models.py ix_chat_message_chat_session_id + message ordering
CREATE INDEX IF NOT EXISTS ix_chat_message_session_idx ON chat_message (chat_session_id, message_index);
CREATE INDEX IF NOT EXISTS ix_chunk_document_id ON chunk (document_id);
CREATE INDEX IF NOT EXISTS ix_document_source_type ON document (source_type);
-- task_queue(status, priority): worker claim query (SKIP LOCKED equivalent)
CREATE INDEX IF NOT EXISTS ix_task_queue_status_priority ON task_queue (status, priority);
CREATE INDEX IF NOT EXISTS ix_user_session_user_id ON user_session (user_id);
CREATE INDEX IF NOT EXISTS ix_user_session_expires_at ON user_session (expires_at);
CREATE INDEX IF NOT EXISTS ix_api_key_user_id ON api_key (user_id);
CREATE INDEX IF NOT EXISTS ix_cc_pair_connector_id ON connector_credential_pair (connector_id);
CREATE INDEX IF NOT EXISTS ix_cc_pair_credential_id ON connector_credential_pair (credential_id);
CREATE INDEX IF NOT EXISTS ix_index_attempt_connector_id ON index_attempt (connector_id);

-- ---------- Seed: Default Assistant persona ----------
-- Port of onyx/prompts/chat_prompts.py DEFAULT_SYSTEM_PROMPT (the template stored on the
-- built-in persona); the {{CURRENT_DATETIME}} marker is kept, exactly as Onyx stores it,
-- and is resolved at prompt-build time (chat/prompt_utils.py). Onyx keeps the default
-- persona at DEFAULT_PERSONA_ID = 0; this port seeds it at id 1 (serial starts at 1).
INSERT INTO persona (id, name, description, system_prompt, is_public)
VALUES (
  1,
  'Default Assistant',
  'The default Onyx assistant.',
  $onyx_prompt$You are an expert assistant who is truthful, nuanced, insightful, and efficient. Your goal is to deeply understand the user's intent, think step-by-step through complex problems, provide clear and accurate answers, and proactively anticipate helpful follow-up information. Whenever there is any ambiguity around the user's query (or more information would be helpful), you use available tools (if any) to get more context.

The current date is {{CURRENT_DATETIME}}.

# Response Style
You use different text styles, bolding, emojis (sparingly), block quotes, and other formatting to make your responses more readable and engaging.
You use proper Markdown and LaTeX to format your responses for math, scientific, and chemical formulas, symbols, etc.
For code you prefer to use Markdown and specify the language.
You can use horizontal rules (---) to separate sections of your responses.
You can use Markdown tables to format your responses for data, lists, and other structured information.$onyx_prompt$,
  true
)
ON CONFLICT (id) DO NOTHING;

-- Keep the serial sequence ahead of the explicitly seeded id.
SELECT setval('persona_id_seq', 1, true);
`;

// Migration 0002 — persona fidelity: the unified default assistant.
// Port of alembic 505c488f6662_merge_default_assistants_into_unified: Onyx's
// default assistant is the unified builtin persona at persona id 0
// (DEFAULT_PERSONA_ID, configs/constants.py:72), named "Assistant", with the
// exact seed row from that migration. The id-1 seed from migration 0001 is
// retired (deleted = true) to mirror the merge semantics.
export const PERSONA_UNIFIED_DEFAULT = `
-- Columns required by MinimalPersonaSnapshot / Persona (server/features/persona/models.py)
ALTER TABLE persona ADD COLUMN IF NOT EXISTS builtin_persona BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE persona ADD COLUMN IF NOT EXISTS is_listed BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE persona ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE persona ADD COLUMN IF NOT EXISTS deleted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE persona ADD COLUMN IF NOT EXISTS display_priority INTEGER NULL;
ALTER TABLE persona ADD COLUMN IF NOT EXISTS starter_messages JSONB NULL;
ALTER TABLE persona ADD COLUMN IF NOT EXISTS icon_name TEXT NULL;
ALTER TABLE persona ADD COLUMN IF NOT EXISTS uploaded_image_id TEXT NULL;
ALTER TABLE persona ADD COLUMN IF NOT EXISTS num_chunks INTEGER NOT NULL DEFAULT 25;

-- Retire the pre-unification default (migration 0001's id-1 row).
UPDATE persona SET deleted = true WHERE id = 1 AND builtin_persona = false;

-- Unified assistant seed row (alembic 505c488f6662, INSERT branch).
INSERT INTO persona (
  id, name, description, system_prompt,
  builtin_persona, is_listed, is_featured, deleted, display_priority, is_public, num_chunks
) VALUES (
  0,
  $onyx_unified$Assistant$onyx_unified$,
  $onyx_unified$Your AI assistant with search, web browsing, and image generation capabilities.$onyx_unified$,
  $onyx_unified$You are a highly capable, thoughtful, and precise assistant. Your goal is to deeply understand the user's intent, ask clarifying questions when needed, think step-by-step through complex problems, provide clear and accurate answers, and proactively anticipate helpful follow-up information. Always prioritize being truthful, nuanced, insightful, and efficient.
The current date is [[CURRENT_DATETIME]]

You use different text styles, bolding, emojis (sparingly), block quotes, and other formatting to make your responses more readable and engaging.
You use proper Markdown and LaTeX to format your responses for math, scientific, and chemical formulas, symbols, etc.: '$$\\n[expression]\\n$$' for standalone cases and '\\( [expression] \\)' when inline.
For code you prefer to use Markdown and specify the language.
You can use Markdown horizontal rules (---) to separate sections of your responses.
You can use Markdown tables to format your responses for data, lists, and other structured information.$onyx_unified$,
  true, true, false, false, 0, true, 25
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  system_prompt = EXCLUDED.system_prompt,
  builtin_persona = true,
  is_listed = true,
  deleted = false,
  display_priority = 0;

-- Persona ownership: port of Persona.user_id (db/models.py) — nullable for
-- builtins (ownerless, readable by everyone).
ALTER TABLE persona ADD COLUMN IF NOT EXISTS user_id UUID NULL REFERENCES onyx_user(id);

-- Keep the serial sequence ahead of the explicitly seeded id.
SELECT setval('persona_id_seq', (SELECT COALESCE(MAX(id), 0) + 1 FROM persona), false);
`;

// Migration 0011 — Enterprise Edition (EE) admin surfaces (Task 4).
// Tables backing the user-groups permissions UI, standard answers, SCIM tokens
// and the usage-report registry, plus the user-group incognito flag.
// Python sources consulted:
//   - /home/z/onyx/backend/onyx/db/models.py UserGroup (incognito_enabled),
//     StandardAnswer / StandardAnswerCategory (onnx_ standard answer tables)
//   - /home/z/onyx/backend/onyx/db/scim.py (SCIM token storage)
//   - /home/z/onyx/backend/onyx/db/usage_report.py (usage report rows)
// All statements are idempotent (IF NOT EXISTS) so the live DB can be upgraded
// ahead of the migration runner without double-applying.
export const EE_ADMIN_SCHEMA = `
-- Port of UserGroup.incognito_enabled (db/models.py): members may start
-- incognito chats while workspace availability is groups-only.
ALTER TABLE user_group ADD COLUMN IF NOT EXISTS incognito_enabled BOOLEAN NOT NULL DEFAULT false;

-- Standard answers (port of db/models.py StandardAnswerCategory /
-- StandardAnswer + the m2m join table). A "deleted" flag mirrors the
-- soft-delete the original API exposes on StandardAnswer.
CREATE TABLE IF NOT EXISTS standard_answer_category (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS standard_answer (
  id                 SERIAL PRIMARY KEY,
  keyword            TEXT NOT NULL,
  answer             TEXT NOT NULL,
  match_regex        BOOLEAN NOT NULL DEFAULT false,
  match_any_keywords BOOLEAN NOT NULL DEFAULT false,
  deleted            BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS standard_answer__category (
  standard_answer_id          INTEGER NOT NULL REFERENCES standard_answer(id) ON DELETE CASCADE,
  standard_answer_category_id INTEGER NOT NULL REFERENCES standard_answer_category(id) ON DELETE CASCADE,
  PRIMARY KEY (standard_answer_id, standard_answer_category_id)
);

-- SCIM bearer tokens (port of db/scim.py SCIMToken): one active token; a
-- rotate deactivates prior rows and records the raw token only once (hash).
CREATE TABLE IF NOT EXISTS scim_token (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  token_display TEXT NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ NULL,
  idp_domain    TEXT NULL
);

-- Usage report registry (port of db/usage_report.py UsageReport): report CSV
-- content is stored inline (small deployments) so /admin/usage-report/:name
-- can stream it back.
CREATE TABLE IF NOT EXISTS usage_report (
  report_name TEXT PRIMARY KEY,
  requestor   TEXT NULL,
  period_from TIMESTAMPTZ NULL,
  period_to   TIMESTAMPTZ NULL,
  content     TEXT NULL,
  time_created TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hot-path indexes for the analytics/date-bucket queries added by Task 4.
CREATE INDEX IF NOT EXISTS ix_chat_message_created_at ON chat_message (created_at);
CREATE INDEX IF NOT EXISTS ix_chat_session_persona_id ON chat_session (persona_id);
CREATE INDEX IF NOT EXISTS ix_user__user_group_group_id ON user__user_group (user_group_id);
`;

export const MIGRATIONS: MigrationVersion[] = [
  {
    id: "0001",
    name: "initial standard schema",
    sql: INITIAL_STANDARD_SCHEMA,
  },
  {
    id: "0002",
    name: "persona fidelity: unified default assistant (alembic 505c488f6662)",
    sql: PERSONA_UNIFIED_DEFAULT,
  },
  {
    id: "0003",
    name: "persona.user_id ownership column (db/models.py Persona.user_id)",
    sql: `ALTER TABLE persona ADD COLUMN IF NOT EXISTS user_id UUID NULL REFERENCES onyx_user(id);`,
  },
  {
    id: "0004",
    name: "model configuration table (db/models.py ModelConfigurationModel)",
    sql: `
CREATE TABLE IF NOT EXISTS model_configuration (
  id                SERIAL PRIMARY KEY,
  llm_provider_id   INTEGER NOT NULL REFERENCES llm_provider(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  is_visible        BOOLEAN NOT NULL DEFAULT true,
  supports_chat     BOOLEAN NOT NULL DEFAULT true,
  supports_image_input BOOLEAN NOT NULL DEFAULT false,
  supports_reasoning   BOOLEAN NOT NULL DEFAULT false,
  supports_decisions   BOOLEAN NOT NULL DEFAULT false,
  max_input_tokens     INTEGER NULL,
  created_at        TIMESTAMPTZ DEFAULT now()
);
`,
  },
  {
    id: "0005",
    name: "user personalization columns + memory table (db/models.py User.440-446, Memory.585)",
    sql: `
ALTER TABLE onyx_user ADD COLUMN IF NOT EXISTS personal_name TEXT NULL;
ALTER TABLE onyx_user ADD COLUMN IF NOT EXISTS personal_role TEXT NULL;
ALTER TABLE onyx_user ADD COLUMN IF NOT EXISTS use_memories BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE onyx_user ADD COLUMN IF NOT EXISTS enable_memory_tool BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE onyx_user ADD COLUMN IF NOT EXISTS user_preferences TEXT NULL;

CREATE TABLE IF NOT EXISTS memory (
  id              SERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES onyx_user(id) ON DELETE CASCADE,
  memory_text     TEXT NOT NULL,
  conversation_id UUID NULL,
  message_id      INTEGER NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
  },
  {
    id: "0006",
    name: "default groups + permissions (alembic 977e834c1427 seed_default_groups, db/models.py UserGroup/User__UserGroup/PermissionGrant)",
    sql: `
-- Supporting tables (port of db/models.py UserGroup / User__UserGroup /
-- PermissionGrant; created here because the minimal initial schema predates them).
CREATE TABLE IF NOT EXISTS user_group (
  id                SERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  is_up_to_date     BOOLEAN NOT NULL DEFAULT true,
  is_up_for_deletion BOOLEAN NOT NULL DEFAULT false,
  is_default        BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user__user_group (
  user_id       UUID NOT NULL REFERENCES onyx_user(id) ON DELETE CASCADE,
  user_group_id INTEGER NOT NULL REFERENCES user_group(id) ON DELETE CASCADE,
  is_manager    BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, user_group_id)
);
CREATE TABLE IF NOT EXISTS permission_grant (
  id           SERIAL PRIMARY KEY,
  group_id     INTEGER NOT NULL REFERENCES user_group(id) ON DELETE CASCADE,
  permission   TEXT NOT NULL,
  grant_source TEXT NOT NULL DEFAULT 'SYSTEM',
  is_deleted   BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT permission_grant_group_permission_key UNIQUE (group_id, permission)
);
ALTER TABLE onyx_user ADD COLUMN IF NOT EXISTS effective_permissions JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE onyx_user ADD COLUMN IF NOT EXISTS is_group_manager BOOLEAN NOT NULL DEFAULT false;

-- Seed default groups — port of alembic 977e834c1427 DEFAULT_GROUPS
-- [("Admin", "admin"), ("Basic", "basic")] with grant_source="SYSTEM".
INSERT INTO user_group (name, is_up_to_date, is_up_for_deletion, is_default)
SELECT 'Admin', true, false, true
WHERE NOT EXISTS (SELECT 1 FROM user_group WHERE name = 'Admin' AND is_default);
INSERT INTO user_group (name, is_up_to_date, is_up_for_deletion, is_default)
SELECT 'Basic', true, false, true
WHERE NOT EXISTS (SELECT 1 FROM user_group WHERE name = 'Basic' AND is_default);
INSERT INTO permission_grant (group_id, permission, grant_source)
SELECT g.id, 'admin', 'SYSTEM' FROM user_group g
WHERE g.name = 'Admin' AND g.is_default
ON CONFLICT (group_id, permission) DO NOTHING;
INSERT INTO permission_grant (group_id, permission, grant_source)
SELECT g.id, 'basic', 'SYSTEM' FROM user_group g
WHERE g.name = 'Basic' AND g.is_default
ON CONFLICT (group_id, permission) DO NOTHING;

-- Assign EXISTING users to their default group (port of
-- on_after_register: is_admin = user_count == 1 -> earliest user is Admin).
INSERT INTO user__user_group (user_id, user_group_id)
SELECT u.id, g.id FROM onyx_user u, user_group g
WHERE g.name = 'Admin' AND g.is_default
  AND u.id = (SELECT id FROM onyx_user ORDER BY created_at ASC, id ASC LIMIT 1)
ON CONFLICT (user_id, user_group_id) DO NOTHING;
INSERT INTO user__user_group (user_id, user_group_id)
SELECT u.id, g.id FROM onyx_user u, user_group g
WHERE g.name = 'Basic' AND g.is_default
  AND NOT EXISTS (SELECT 1 FROM user__user_group m WHERE m.user_id = u.id)
ON CONFLICT (user_id, user_group_id) DO NOTHING;

-- Materialize effective_permissions (port of recompute_user_permissions__no_commit:
-- directly granted permissions from group membership; implication expansion
-- happens at read time).
UPDATE onyx_user u SET effective_permissions = agg.perms::jsonb
FROM (
  SELECT m.user_id, jsonb_agg(DISTINCT pg.permission) AS perms
  FROM user__user_group m
  JOIN permission_grant pg
    ON pg.group_id = m.user_group_id AND pg.is_deleted = false
  GROUP BY m.user_id
) agg WHERE u.id = agg.user_id;
`,
  },
  {
    id: "0007",
    name: "llm_provider full column set (db/models.py LLMProvider.3782)",
    sql: `
ALTER TABLE llm_provider ADD COLUMN IF NOT EXISTS api_version TEXT NULL;
ALTER TABLE llm_provider ADD COLUMN IF NOT EXISTS deployment_name TEXT NULL;
ALTER TABLE llm_provider ADD COLUMN IF NOT EXISTS custom_config JSONB NULL;
ALTER TABLE llm_provider ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE llm_provider ADD COLUMN IF NOT EXISTS is_auto_mode BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE llm_provider ADD COLUMN IF NOT EXISTS zoom_voice_provider_id INTEGER NULL;
ALTER TABLE llm_provider ADD COLUMN IF NOT EXISTS is_default_vision_provider BOOLEAN NULL;
ALTER TABLE llm_provider ADD COLUMN IF NOT EXISTS default_vision_model TEXT NULL;
`,
  },
  {
    id: "0008",
    name: "persona.default_model_configuration_id (db/models.py Persona v5.1.3)",
    sql: `
ALTER TABLE persona ADD COLUMN IF NOT EXISTS default_model_configuration_id INTEGER NULL;
`,
  },
  {
    id: "0009",
    name: "chat_session.llm_override + chat_message.preferred_response_id (db/models.py ChatSession/ChatMessage v5.1.3)",
    sql: `
ALTER TABLE chat_session ADD COLUMN IF NOT EXISTS llm_override JSONB NULL;
ALTER TABLE chat_message ADD COLUMN IF NOT EXISTS preferred_response_id INTEGER NULL;
`,
  },
  {
    id: "0010",
    name: "onyx_user.preferences JSONB (db/models.py User.preferences — pinned/visible assistants)",
    sql: `
ALTER TABLE onyx_user ADD COLUMN IF NOT EXISTS preferences JSONB NULL;
`,
  },
  {
    id: "0011",
    name: "EE admin surfaces: user-group incognito flag, standard answers, scim_token, usage_report",
    sql: EE_ADMIN_SCHEMA,
  },
  {
    id: "0012",
    name: "Craft build sessions (v5.1.3 craft surface)",
    sql: `
CREATE TABLE IF NOT EXISTS build_session (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES onyx_user(id) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT 'New Build',
  status      TEXT NOT NULL DEFAULT 'ready',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS build_message (
  id         SERIAL PRIMARY KEY,
  session_id UUID REFERENCES build_session(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content    TEXT NOT NULL,
  turn_id    INTEGER NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- build_message.message_metadata — task-10-craft addition to the base block:
-- the craft frontend materializes the reloaded assistant transcript ONLY from
-- message_metadata (web/src/app/craft/hooks/useBuildSessionStore.ts
-- convertMessagesToStreamItems drops assistant rows without it), so each
-- assistant row persists its packet metadata ({type:"agent_message",
-- content}) and each user row its {type:"user_message", content, attachments}.
-- build_message.turn_id stays INTEGER: it stores the 0-based turn index —
-- the same number reported as turn_index in the API responses. The opaque
-- turn id (a uuid, string in the API) lives only in the in-memory turn
-- registry of server/routes/build.ts; the frontend correlates persisted
-- messages by turn_index, never by turn id (streamingTypes.ts
-- ApiMessageResponse has no turn_id field).
ALTER TABLE build_message ADD COLUMN IF NOT EXISTS message_metadata JSONB NULL;
`,
  },
  // Migration 0013 — ported from the deployed repo history: replaces legacy
  // bb13b8a-era craft tables with the v5.1.3 surface shapes (no-op on fresh
  // databases where 0012 already created the same shapes; repairs shared
  // production databases that recorded an older "0012" build-table shape).
{
    id: "0013",
    name: "Craft tables: replace legacy bb13b8a-era shapes with the v5.1.3 craft surface shapes",
    sql: `
-- The pre-revert cloud-parity implementation registered its own "0012" on
-- shared production databases with a DIFFERENT build-table shape (build_turn
-- / build_artifact rows, build_message.type instead of role, TEXT ids, no
-- updated_at on build_session). Because the version id is already recorded,
-- the runner skips this repo's 0012 there and the current surface queries
-- columns that do not exist (500s on /build/*). Legacy tables are empty on
-- production (craft never served traffic), so replace them outright. On
-- fresh databases 0012 already created the same shapes — this is a no-op.
DROP TABLE IF EXISTS build_artifact;
DROP TABLE IF EXISTS build_turn;
DROP TABLE IF EXISTS build_message;
DROP TABLE IF EXISTS build_session;

CREATE TABLE IF NOT EXISTS build_session (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES onyx_user(id) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT 'New Build',
  status      TEXT NOT NULL DEFAULT 'ready',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS build_message (
  id         SERIAL PRIMARY KEY,
  session_id UUID REFERENCES build_session(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content    TEXT NOT NULL,
  turn_id    INTEGER NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE build_message ADD COLUMN IF NOT EXISTS message_metadata JSONB NULL;
`,
  },
];
