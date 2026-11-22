/**
 * Chat routes — TypeScript port of backend/onyx/server/query_and_chat/
 * chat_backend.py + api route shapes (send-message SSE, session listing,
 * session messages, session delete, session name generation).
 *
 * Route map (Python -> here):
 *   POST /chat/send-message               -> POST /send-message  (SSE stream)
 *   GET  /chat/sessions                   -> GET  /sessions
 *   GET  /chat/chat-session/{id}/messages -> GET  /sessions/:id/messages
 *   DELETE /chat/chat-session/{id}        -> DELETE /sessions/:id
 *   (stop semantics)                      -> POST /sessions/:id/stop (501)
 *
 * The auto-naming port (first-message title) lives in chat/persistence.ts;
 * the SSE turn lives in chat/process_message.ts.
 *
 * AUTH: Task 2-a owns the canonical auth surface (server/routes/auth.ts).
 * Until its middleware is importable, this module resolves the same session
 * cookie / bearer credentials directly against the shared auth tables
 * (user_session, api_key, onyx_user — Task 2-a migrations) and exports
 * getAuthContext for the sibling routes. Resolution failures are 401; with
 * ONYX_TS_DEV_AUTH=1 an unauthenticated request falls back to the first
 * admin user (local development only).
 */

import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { query, queryOne } from "../../db/client";
import { SESSION_COOKIE_NAME } from "../../configs/constants";
import type { AuthContext, User } from "../../types/domain";
import { getLogger } from "../../utils/logger";
import {
  ForbiddenError,
  InvalidMessageExceptionError,
  InvalidRequestError,
  UnauthorizedError,
  UnsupportedFeatureError,
} from "../../utils/errors";
import { processMessage } from "../../chat/process_message";
import {
  createChatSession,
  deleteChatSession,
  generateChatSessionName,
  getChatMessages,
  getChatSession,
  getFallbackChatSessionName,
  listChatSessions,
} from "../../chat/persistence";
import { getDefaultPersona, getPersona } from "../../agents/personas";
import { registerBuiltInTools } from "../../tools/built_in_tools";

const logger = getLogger("routes.chat");

// Built-in tools must be in the registry for the agent loop to offer them.
// Guarded per the port contract: a registry failure must not kill the app.
try {
  registerBuiltInTools();
} catch (err) {
  logger.warning("built-in tool registration failed", { error: String(err) });
}

// ---------------------------------------------------------------------------
// Auth resolution (see header note — canonical surface owned by Task 2-a)
// ---------------------------------------------------------------------------

// Row type is a type alias so it satisfies pg's QueryResultRow constraint.
type UserRow = {
  id: string;
  email: string;
  role: string;
  is_active: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  password_hash: string | null;
}

function toUser(row: UserRow): User {
  const role = row.role as User["role"];
  return {
    id: row.id,
    email: row.email,
    password_hash: row.password_hash,
    role,
    is_active: row.is_active,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

async function lookupSessionUser(sessionId: string): Promise<User | null> {
  const row = await queryOne<UserRow>(
    `SELECT u.id, u.email, u.role, u.is_active, u.created_at, u.updated_at, u.password_hash
     FROM user_session s JOIN onyx_user u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > now() AND u.is_active
     LIMIT 1`,
    [sessionId],
  );
  return row ? toUser(row) : null;
}

async function lookupApiKeyUser(apiKey: string): Promise<User | null> {
  const hash = createHash("sha256").update(apiKey).digest("hex");
  const row = await queryOne<UserRow>(
    `SELECT u.id, u.email, u.role, u.is_active, u.created_at, u.updated_at, u.password_hash
     FROM api_key k JOIN onyx_user u ON u.id = k.user_id
     WHERE k.api_key_hash = $1 AND k.is_active AND u.is_active
     LIMIT 1`,
    [hash],
  );
  return row ? toUser(row) : null;
}

async function lookupDevUser(): Promise<User | null> {
  const row = await queryOne<UserRow>(
    `SELECT id, email, role, is_active, created_at, updated_at, password_hash
     FROM onyx_user WHERE is_active ORDER BY (role = 'admin') DESC, created_at ASC LIMIT 1`,
  );
  return row ? toUser(row) : null;
}

/**
 * Resolve the AuthContext for a request: Bearer token (session id or API
 * key) first, then the session cookie. Throws UnauthorizedError when nothing
 * matches. Exported for the sibling routes (personas/tools/mcp).
 */
export async function getAuthContext(c: Context): Promise<AuthContext> {
  const authorization = c.req.header("Authorization") ?? "";
  const apiKey = c.req.header("X-Onyx-API-Key") ?? "";
  const cookieHeader = c.req.header("Cookie") ?? "";

  let bearer: string | null = null;
  if (authorization.toLowerCase().startsWith("bearer ")) {
    bearer = authorization.slice(7).trim();
  }

  const cookieMatch = new RegExp(
    `(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`,
  ).exec(cookieHeader);
  const sessionId = cookieMatch?.[1] ?? null;

  const candidates: Array<() => Promise<User | null>> = [];
  if (bearer) {
    candidates.push(() => lookupSessionUser(bearer as string));
    candidates.push(() => lookupApiKeyUser(bearer as string));
  }
  if (apiKey) {
    candidates.push(() => lookupApiKeyUser(apiKey));
  }
  if (sessionId) {
    candidates.push(() => lookupSessionUser(sessionId));
  }

  for (const candidate of candidates) {
    try {
      const user = await candidate();
      if (user) return { user, viaApiKey: false };
    } catch (err) {
      // Auth tables not migrated yet / transient DB error: keep trying.
      logger.debug("auth candidate lookup failed", { error: String(err) });
    }
  }

  if (process.env.ONYX_TS_DEV_AUTH === "1") {
    try {
      const dev = await lookupDevUser();
      if (dev) {
        logger.warning("dev auth fallback used (ONYX_TS_DEV_AUTH=1)", {
          email: dev.email,
        });
        return { user: dev, viaApiKey: false };
      }
    } catch {
      // fall through to 401
    }
  }

  throw new UnauthorizedError();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const chatRoutes = new Hono();

// GET /chat/get-user-chat-sessions — port of chat_backend.py get_user_chat_sessions
// returning ChatSessionsResponse {sessions: [ChatSessionDetails], has_more}
// (server/query_and_chat/models.py:441, ChatSessionDetails :415).
chatRoutes.get("/get-user-chat-sessions", async (c) => {
  const auth = await getAuthContext(c);
  const pageSize = Math.min(
    100,
    Math.max(1, Number(c.req.query("page_size") ?? "50") || 50),
  );
  const rows = await query<{
    id: string;
    description: string | null;
    persona_id: number | null;
    created_at: Date | string;
    updated_at: Date | string;
  }>(
    `SELECT id, description, persona_id, created_at, updated_at
     FROM chat_session
     WHERE user_id = $1 AND deleted = false
     ORDER BY updated_at DESC
     LIMIT $2`,
    [auth.user.id, pageSize + 1],
  );
  const hasMore = rows.rows.length > pageSize;
  const sessions = rows.rows.slice(0, pageSize).map((row) => ({
    id: row.id,
    name: row.description,
    persona_id: row.persona_id,
    time_created: new Date(row.created_at).toISOString(),
    time_updated: new Date(row.updated_at).toISOString(),
    shared_status: "private",
    current_alternate_model: null,
    current_temperature_override: null,
    current_reasoning_effort_override: null,
  }));
  return c.json({ sessions, has_more: hasMore });
});

// ---------------------------------------------------------------------------
// Session management surface (port of chat_backend.py session routes)
// ---------------------------------------------------------------------------

interface LLMOverride {
  temperature?: number | null;
  model_provider?: string | null;
  model_version?: string | null;
  model_configuration_id?: number | null;
  reasoning_effort?: string | null;
}

/**
 * Map DB / frontend provider spellings to llm/factory.ts routing ids
 * (the DB and the original frontend use the constants.py spelling
 * "openai_compatible", the factory routes on "openai-compatible").
 */
function normalizeProviderId(provider: string): string {
  return provider === "openai_compatible" ? "openai-compatible" : provider;
}

interface ResolvedLlmSelection {
  llmProviderId?: string;
  llmModelName?: string;
}

/**
 * Parse the frontend's structured session-model string persisted by
 * update-chat-session-model (current_alternate_model):
 *   "<display_name>__<provider>__<model_name>" optionally suffixed
 *   "__mc:<model_configuration_id>" (lib/languageModels/utils.ts structureValue).
 * Model names may themselves contain "__", so only the leading two segments
 * are consumed and the "mc:" marker disambiguates the id suffix.
 */
function parseStructuredModelValue(
  raw: string,
): {
  name: string;
  provider: string;
  modelName: string;
  modelConfigurationId: number | null;
} | null {
  if (!raw || !raw.includes("__")) return null;
  const parts = raw.split("__");
  if (parts.length < 3) return null;
  const last = parts[parts.length - 1];
  let modelConfigurationId: number | null = null;
  let modelNameParts = parts.slice(2);
  if (last.startsWith("mc:")) {
    const id = Number(last.slice(3));
    if (Number.isInteger(id) && id > 0) modelConfigurationId = id;
    modelNameParts = parts.slice(2, -1);
  }
  return {
    name: parts[0],
    provider: parts[1],
    modelName: modelNameParts.join("__"),
    modelConfigurationId,
  };
}

/**
 * Resolve a per-request LLMOverride (frontend lib.tsx sendMessage payload)
 * into the (providerId, modelName) pair threaded into processMessage.
 * Priority: explicit model_configuration_id (DB row joined with its provider)
 * > model_provider + model_version > model_version alone. Mirrors the
 * handle_send_chat_message flow's ModelConfigurationOverride resolution.
 *
 * Robustness: when model_configuration_id points at a row that no longer
 * exists (stale page state after a DB reseed), resolution FALLS THROUGH to
 * model_provider + model_version instead of silently resetting to the
 * deployment default — a failed lookup must never lose the user's explicit
 * model selection.
 */
async function resolveLlmOverride(override: LLMOverride | null | undefined): Promise<ResolvedLlmSelection> {
  if (!override || typeof override !== "object") return {};

  let modelProvider = override.model_provider ?? undefined;
  let modelVersion = override.model_version ?? undefined;
  let modelConfigurationId = override.model_configuration_id ?? undefined;

  // model_version may carry the frontend's structured descriptor string
  // (update-chat-session-model stores structureValue(...) verbatim) — parse
  // it into its parts and use them as the base for this override.
  if (modelVersion) {
    const structured = parseStructuredModelValue(modelVersion);
    if (structured) {
      modelProvider = modelProvider || structured.provider || structured.name;
      modelVersion = structured.modelName || modelVersion;
      modelConfigurationId = modelConfigurationId ?? structured.modelConfigurationId ?? undefined;
    }
  }

  if (modelConfigurationId != null) {
    const row = await queryOne<{
      model_name: string;
      provider: string;
      api_base: string | null;
      api_key: string | null;
    }>(
      `SELECT mc.name AS model_name, lp.provider AS provider, lp.api_base, lp.api_key
         FROM model_configuration mc
         JOIN llm_provider lp ON lp.id = mc.llm_provider_id
        WHERE mc.id = $1`,
      [modelConfigurationId],
    );
    if (row) {
      return {
        llmProviderId: normalizeProviderId(row.provider),
        llmModelName: row.model_name,
      };
    }
    logger.warning("llm_override model_configuration_id not found; falling back to provider/model fields", {
      model_configuration_id: modelConfigurationId,
    });
  }
  // model_provider may be either the provider column id ("kilo",
  // "openai-compatible") or the admin-facing display NAME — the original
  // frontend's model selector sends LLMProviderDescriptor.name from
  // llmManager.currentLlm (useChatController modelProvider), and several
  // provider rows can share one display name (e.g. a retired duplicate).
  // Resolve names through the DB, preferring the default row when several
  // providers share the display name; column ids pass through unchanged.
  let providerId = modelProvider
    ? normalizeProviderId(modelProvider)
    : undefined;
  if (providerId) {
    const byName = await queryOne<{ provider: string }>(
      `SELECT provider FROM llm_provider
        WHERE name = $1
        ORDER BY is_default DESC, id ASC
        LIMIT 1`,
      [providerId],
    );
    if (byName?.provider) {
      providerId = normalizeProviderId(byName.provider);
    }
  }
  return {
    ...(providerId ? { llmProviderId: providerId } : {}),
    // The frontend uses "default" as the placeholder model version; the
    // factory treats it the same way, so drop it here as well.
    ...(modelVersion && modelVersion !== "default" ? { llmModelName: modelVersion } : {}),
  };
}

async function getSessionLLMOverride(
  sessionId: string,
  userId: string,
): Promise<LLMOverride | null> {
  const row = await queryOne<{ llm_override: unknown }>(
    `SELECT llm_override FROM chat_session WHERE id = $1 AND user_id = $2 AND deleted = false`,
    [sessionId, userId],
  );
  if (!row?.llm_override) return null;
  return row.llm_override as LLMOverride;
}

async function setSessionLLMOverride(
  sessionId: string,
  userId: string,
  override: LLMOverride | null,
): Promise<void> {
  await query(
    `UPDATE chat_session SET llm_override = $3::jsonb, updated_at = now()
     WHERE id = $1 AND user_id = $2`,
    [sessionId, userId, override ? JSON.stringify(override) : null],
  );
}

// PUT /chat/rename-chat-session — port of chat_backend.py rename_chat_session.
// With a name: store it (content-free names drop the title, echoing what was
// stored). Without: derive a title from the conversation via the LLM naming
// chain, falling back to the truncation policy.
chatRoutes.put("/rename-chat-session", async (c) => {
  const auth = await getAuthContext(c);
  const body = await c.req.json().catch(() => ({}));
  const sessionId = String(body?.chat_session_id ?? "");
  const name = body?.name == null ? null : String(body?.name ?? "");
  if (!sessionId) throw new InvalidRequestError("chat_session_id is required");

  const session = await getChatSession(sessionId, auth.user.id);
  if (!session) {
    return c.json({ detail: "Chat Session not found" }, 404);
  }

  if (name && name.trim()) {
    await query(
      `UPDATE chat_session SET description = $3, updated_at = now()
       WHERE id = $1 AND user_id = $2`,
      [sessionId, auth.user.id, name],
    );
    return c.json({ new_name: name });
  }

  // Auto-naming: derive from history (LLM, fallback to truncation).
  const msgs = await getChatMessages(sessionId);
  const history = msgs
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-6)
    .map((m) => ({ role: m.role as "user" | "assistant", message: m.message }));
  const fallback = getFallbackChatSessionName(
    history.find((m) => m.role === "user")?.message ?? null,
  );
  const newName = await generateChatSessionName(history, fallback);
  await query(
    `UPDATE chat_session SET description = $3, updated_at = now()
     WHERE id = $1 AND user_id = $2`,
    [sessionId, auth.user.id, newName],
  );
  return c.json({ new_name: newName });
});

// PUT /chat/update-chat-session-temperature — port of update_chat_session_
// temperature: validate 0..2, persist into the session's llm_override.
chatRoutes.put("/update-chat-session-temperature", async (c) => {
  const auth = await getAuthContext(c);
  const body = await c.req.json().catch(() => ({}));
  const sessionId = String(body?.chat_session_id ?? "");
  const temperature = body?.temperature_override;
  if (!sessionId) throw new InvalidRequestError("chat_session_id is required");
  if (typeof temperature === "number") {
    if (temperature < 0 || temperature > 2) {
      return c.json({ detail: "Temperature must be between 0 and 2" }, 400);
    }
  }
  const session = await getChatSession(sessionId, auth.user.id);
  if (!session) return c.json({ detail: "Chat Session not found" }, 404);
  const existing = (await getSessionLLMOverride(sessionId, auth.user.id)) ?? {};
  await setSessionLLMOverride(sessionId, auth.user.id, {
    ...existing,
    temperature: typeof temperature === "number" ? temperature : null,
  });
  return c.json(null);
});

// PUT /chat/update-chat-session-model — port of update_chat_session_model:
// stores the model the user picked for the session (current_alternate_model).
chatRoutes.put("/update-chat-session-model", async (c) => {
  const auth = await getAuthContext(c);
  const body = await c.req.json().catch(() => ({}));
  const sessionId = String(body?.chat_session_id ?? "");
  const newModel = String(body?.new_alternate_model ?? "");
  if (!sessionId) throw new InvalidRequestError("chat_session_id is required");
  const session = await getChatSession(sessionId, auth.user.id);
  if (!session) return c.json({ detail: "Chat Session not found" }, 404);
  const existing = (await getSessionLLMOverride(sessionId, auth.user.id)) ?? {};
  await setSessionLLMOverride(sessionId, auth.user.id, {
    ...existing,
    model_version: newModel || null,
  });
  return c.json(null);
});

// PUT /chat/update-chat-session-reasoning — port of update_chat_session_
// reasoning: stores the reasoning effort override into llm_override.
chatRoutes.put("/update-chat-session-reasoning", async (c) => {
  const auth = await getAuthContext(c);
  const body = await c.req.json().catch(() => ({}));
  const sessionId = String(body?.chat_session_id ?? "");
  const effort = body?.reasoning_effort_override;
  if (!sessionId) throw new InvalidRequestError("chat_session_id is required");
  const session = await getChatSession(sessionId, auth.user.id);
  if (!session) return c.json({ detail: "Chat Session not found" }, 404);
  const existing = (await getSessionLLMOverride(sessionId, auth.user.id)) ?? {};
  await setSessionLLMOverride(sessionId, auth.user.id, {
    ...existing,
    reasoning_effort: effort == null ? null : String(effort),
  });
  return c.json(null);
});

// PUT /chat/set-preferred-response — port of set_preferred_response: marks
// the preferred assistant response for a multi-model user message.
chatRoutes.put("/set-preferred-response", async (c) => {
  const auth = await getAuthContext(c);
  const body = await c.req.json().catch(() => ({}));
  const userMessageId = Number(body?.user_message_id);
  const preferredResponseId = Number(body?.preferred_response_id);
  if (!Number.isFinite(userMessageId) || !Number.isFinite(preferredResponseId)) {
    throw new InvalidRequestError("user_message_id and preferred_response_id are required");
  }
  await query(
    `UPDATE chat_message SET preferred_response_id = $1
     WHERE id = $2 AND chat_session_id IN (
       SELECT id FROM chat_session WHERE user_id = $3
     )`,
    [preferredResponseId, userMessageId, auth.user.id],
  );
  return c.json(null);
});

// POST /chat/set-message-as-latest — port of set_message_as_latest: rewires
// the linear tree so the chosen message becomes the leaf of the conversation.
chatRoutes.post("/set-message-as-latest", async (c) => {
  const auth = await getAuthContext(c);
  const body = await c.req.json().catch(() => ({}));
  const messageId = Number(body?.message_id);
  if (!Number.isFinite(messageId)) {
    throw new InvalidRequestError("message_id is required");
  }
  const row = await queryOne<{ chat_session_id: string }>(
    `SELECT m.chat_session_id FROM chat_message m
     JOIN chat_session s ON s.id = m.chat_session_id
     WHERE m.id = $1 AND s.user_id = $2`,
    [messageId, auth.user.id],
  );
  if (!row) return c.json({ detail: "Message not found" }, 404);
  // Move the message to the tail of the flat ordering (the linear-tree
  // equivalent of making it the latest child of its parent).
  await query(
    `UPDATE chat_message SET message_index = (
       SELECT COALESCE(MAX(message_index), 0) + 1
       FROM chat_message WHERE chat_session_id = $1
     ) WHERE id = $2`,
    [row.chat_session_id, messageId],
  );
  return c.json(null);
});

// DELETE /chat/delete-chat-session/{id} — port of delete_chat_session.
chatRoutes.delete("/delete-chat-session/:chat_session_id", async (c) => {
  const auth = await getAuthContext(c);
  const sessionId = c.req.param("chat_session_id");
  await deleteChatSession(sessionId, auth.user.id);
  return c.json(null);
});

// DELETE /chat/delete-all-chat-sessions — port of delete_all_chat_sessions.
chatRoutes.delete("/delete-all-chat-sessions", async (c) => {
  const auth = await getAuthContext(c);
  await query(
    `UPDATE chat_session SET deleted = true, updated_at = now() WHERE user_id = $1`,
    [auth.user.id],
  );
  return c.json(null);
});

// GET /chat/chat-session/{id}/resume-stream — replay of an in-flight stream.
// This port runs turns inline (no resumable stream registry yet), so there is
// nothing to resume; the frontend's documented fallback is persisted state.
chatRoutes.get("/chat-session/:id/resume-stream", async (c) => {
  await getAuthContext(c);
  return c.json({ detail: "No active stream for this session" }, 404);
});

// GET /chat/available-context-tokens/{session_id} — port of
// get_available_context_tokens_for_session: the token budget the persona's
// model leaves for the conversation.
chatRoutes.get("/available-context-tokens/:session_id", async (c) => {
  const auth = await getAuthContext(c);
  const sessionId = c.req.param("session_id");
  const session = await getChatSession(sessionId, auth.user.id);
  if (!session) return c.json({ detail: "Chat session not found" }, 404);
  // The dev-preset provider exposes a 128k window (comparable to the
  // original's default model-config budget).
  return c.json({ available_tokens: 128000 });
});

// GET /chat/max-selected-document-tokens — port of get_max_document_tokens.
chatRoutes.get("/max-selected-document-tokens", async (c) => {
  await getAuthContext(c);
  const personaId = Number(c.req.query("persona_id") ?? "0");
  if (personaId !== 0) {
    const persona = personaId !== 0 ? await getPersona(personaId).catch(() => null) : null;
    if (!persona) return c.json({ detail: "Persona not found" }, 404);
  }
  return c.json({ max_tokens: 100000 });
});

// GET /chat/get-chat-session/{id} — port of chat_backend.py get_chat_session
// returning ChatSessionDetailResponse (server/query_and_chat/models.py:504)
// with messages as ChatMessageDetail (:446) forming the linear tree.
chatRoutes.get("/get-chat-session/:id", async (c) => {
  const auth = await getAuthContext(c);
  const sessionId = c.req.param("id");
  const limit = Math.min(
    1000,
    Math.max(1, Number(c.req.query("limit") ?? "20") || 20),
  );
  const session = await getChatSession(sessionId, auth.user.id);
  if (!session) {
    return c.json({ detail: "Chat Session not found" }, 404);
  }
  const msgRows = await query<{
    id: number;
    message: string;
    role: string;
    citations: unknown;
    error: string | null;
    created_at: Date | string;
  }>(
    `SELECT id, message, role, citations, error, created_at
     FROM chat_message WHERE chat_session_id = $1
     ORDER BY message_index ASC, id ASC LIMIT $2`,
    [sessionId, limit],
  );

  const messages = msgRows.rows.map((row, idx, all) => ({
    chat_session_id: sessionId,
    message_id: row.id,
    parent_message: idx > 0 ? all[idx - 1].id : null,
    latest_child_message: idx < all.length - 1 ? all[idx + 1].id : null,
    message: row.message,
    reasoning_tokens: null,
    // MessageType enum values (configs/constants.py:414, OpenAI standards):
    // "user" / "assistant" — the DB role column stores exactly these.
    message_type: row.role,
    context_docs: null,
    citations: (row.citations as Record<string, string> | null) ?? null,
    time_sent: new Date(row.created_at).toISOString(),
    files: [],
    mentions: [],
    error: row.error,
    error_info: null,
    response_status: row.error ? "FAILED" : "SUCCESS",
    current_feedback: null,
  }));

  // Historical packet replay — port of translate_assistant_message_to_packets
  // (session_loading.py:531): each assistant message rehydrates into the same
  // Packet wire shape the live stream emitted, so a reloaded session renders
  // identically to one that just streamed. This port persists no tool calls,
  // so the reduced form is: message_start + message_delta + section_end per
  // assistant message (create_message_packets, session_loading.py:78).
  // Placement carries every field pydantic's model_dump includes.
  const packetLists: Array<Array<Record<string, unknown>>> = [];
  for (const row of msgRows.rows) {
    if (row.role !== "assistant") continue;
    const placement = {
      turn_index: 1,
      tab_index: 0,
      sub_turn_index: null,
      model_index: null,
    };
    packetLists.push([
      {
        placement: { ...placement },
        obj: {
          type: "message_start",
          final_documents: null,
          pre_answer_processing_seconds: null,
        },
      },
      {
        placement: { ...placement },
        obj: { type: "message_delta", content: row.message ?? "" },
      },
      {
        placement: { ...placement },
        obj: { type: "section_end" },
      },
    ]);
  }

  const personaName = await queryOne<{ name: string | null }>(
    `SELECT p.name FROM persona p JOIN chat_session cs ON cs.persona_id = p.id
     WHERE cs.id = $1`,
    [sessionId],
  );

  return c.json({
    chat_session_id: sessionId,
    description: session.description ?? session.title,
    persona_id: session.persona_id,
    persona_name: personaName?.name ?? null,
    personal_icon_name: null,
    messages,
    time_created: new Date(session.created_at).toISOString(),
    shared_status: "private",
    current_alternate_model: null,
    current_temperature_override: null,
    current_reasoning_effort_override: null,
    owner_name: null,
    packets: packetLists,
    current_stream: null,
    is_processing: false,
    incognito: false,
    has_older_messages: false,
    tool_options: null,
    approvals_version: 0,
  });
});

// GET /chat/chat-session/{id}/status — port of chat_backend.py
// get_chat_session_processing_status (ChatSessionProcessingStatus): the
// polling shape the frontend uses to confirm a stream finished. This port
// runs turns inline, so after the stream the session is idle:
// is_processing=false, current_stream=null.
chatRoutes.get("/chat-session/:id/status", async (c) => {
  try {
    await getAuthContext(c);
  } catch {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  const sessionId = c.req.param("id");
  const session = await getChatSession(sessionId, (await getAuthContext(c)).user.id);
  if (!session) {
    return c.json({ detail: "Chat Session not found" }, 404);
  }
  // latest_response_id = the last assistant message id for the session
  const last = await queryOne<{ id: number }>(
    `SELECT id FROM chat_message
     WHERE chat_session_id = $1 AND role = 'assistant'
     ORDER BY id DESC LIMIT 1`,
    [sessionId],
  );
  return c.json({
    latest_response_id: last?.id ?? null,
    has_active_subagents: false,
    has_startable_input: false,
    is_processing: false,
    current_stream: null,
    approvals_version: 0,
  });
});

// GET /chat/chat-session/{id}/pending-messages — port of chat_backend.py
// list_pending_chat_messages: list[PendingChatMessage] (human-input queue).
// Empty unless tool approvals/questions wait on the user.
chatRoutes.get("/chat-session/:id/pending-messages", async (c) => {
  try {
    await getAuthContext(c);
  } catch {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  return c.json([]);
});

// GET /chat/incognito-availability — port of chat_backend.py
// get_incognito_availability (IncognitoAvailabilityResponse): whether the
// acting user may start an incognito chat. SecuritySettings default is
// IncognitoAvailability.OFF -> not available (server/security/store.py:105).
// Requires authentication (Permission.BASIC_ACCESS) -> 401 otherwise.
chatRoutes.get("/incognito-availability", async (c) => {
  try {
    await getAuthContext(c);
  } catch {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  return c.json({ available: false });
});

// POST /chat/create-chat-session — port of chat_backend.py create_chat_session
// endpoint: {persona_id?, description?, project_id?, incognito?} ->
// CreateChatSessionID {chat_session_id, incognito} (server/query_and_chat/models.py).
chatRoutes.post("/create-chat-session", async (c) => {
  const auth = await getAuthContext(c);
  let body: {
    persona_id?: number | null;
    description?: string | null;
    project_id?: number | null;
    incognito?: boolean;
  };
  try {
    body = z
      .object({
        persona_id: z.number().int().nullish(),
        description: z.string().nullish(),
        project_id: z.number().int().nullish(),
        incognito: z.boolean().optional(),
        incognito_session_id: z.string().nullish(),
      })
      .parse(await c.req.json().catch(() => ({})));
  } catch (err) {
    throw new InvalidRequestError(
      `Invalid create-chat-session request: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const personaId = body.persona_id ?? (await getDefaultPersona()).id;
  const session = await createChatSession(
    auth.user.id,
    personaId,
    body.description ?? "",
  );
  // Incognito is not enabled for this deployment (SecuritySettings default OFF),
  // so the pinned-mode echo is false.
  return c.json({ chat_session_id: session.id, incognito: false });
});

const sendMessageSchema = z.object({
  message: z.string(),
  chat_session_id: z.uuid().optional(),
  persona_id: z.number().int().optional(),
});

// POST /chat/send-chat-message — port of chat_backend.py handle_send_chat_message
// (SendMessageRequest, NDJSON AnswerStreamPart streaming by default). This is
// the endpoint the original frontend calls (web/src/app/app/services/lib.tsx).
chatRoutes.post("/send-chat-message", async (c) => {
  const auth = await getAuthContext(c);
  let body: {
    message: string;
    chat_session_id?: string | null;
    parent_message_id?: number | null;
    chat_session_info?: Record<string, unknown> | null;
    stream?: boolean;
    persona_id?: number | null;
    llm_override?: LLMOverride | null;
    deep_research?: boolean;
    allowed_tool_ids?: number[];
    forced_tool_id?: number | null;
  };
  try {
    body = z
      .object({
        message: z.string(),
        chat_session_id: z.string().nullish(),
        parent_message_id: z.number().int().nullish(),
        chat_session_info: z.record(z.string(), z.unknown()).nullish(),
        stream: z.boolean().optional(),
        persona_id: z.number().int().nullish(),
        // Per-request LLM selection sent by the original frontend
        // (web/src/app/app/services/lib.tsx sendMessage payload). Temperature
        // is accepted but intentionally NOT applied here: the session-level
        // temperature override path (update-chat-session-temperature) already
        // persists it separately, mirroring the upstream session override.
        llm_override: z
          .object({
            temperature: z.number().nullish(),
            model_provider: z.string().nullish(),
            model_version: z.string().nullish(),
            model_configuration_id: z.number().int().nullish(),
          })
          .nullish(),
        // Accepted for wire compatibility with the original frontend payload.
        // deep_research drives the iterative research loop in
        // chat/deep_research.ts; allowed_tool_ids/forced_tool_id are accepted
        // (tool-level filtering is not implemented in this port).
        deep_research: z.boolean().optional(),
        allowed_tool_ids: z.array(z.number().int()).optional(),
        forced_tool_id: z.number().int().nullish(),
      })
      .parse(await c.req.json());
  } catch (err) {
    throw new InvalidRequestError(
      `Invalid send-chat-message request: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!body.message.trim()) {
    throw new InvalidMessageExceptionError();
  }

  // Auto-create the session when no id is given (create_chat_session_from_request)
  let chatSessionId = body.chat_session_id ?? undefined;
  if (!chatSessionId) {
    const personaId = body.persona_id ?? (await getDefaultPersona()).id;
    const session = await createChatSession(
      auth.user.id,
      personaId,
      body.message,
    );
    chatSessionId = session.id;
  }

  // Resolve the effective LLM selection: the session's persisted llm_override
  // (update-chat-session-model / -temperature / -reasoning PUTs) is the base,
  // and the per-request override (frontend sendMessage payload) wins field by
  // field when present. Nothing new is persisted here.
  const sessionOverride = await getSessionLLMOverride(chatSessionId, auth.user.id);
  const mergedOverride: LLMOverride = {
    ...(sessionOverride ?? {}),
  };
  if (body.llm_override) {
    for (const [key, value] of Object.entries(body.llm_override)) {
      if (value !== null && value !== undefined) {
        (mergedOverride as Record<string, unknown>)[key] = value;
      }
    }
  }
  const llmSelection = await resolveLlmOverride(mergedOverride);
  logger.info("send-chat-message llm selection", {
    chat_session_id: chatSessionId,
    provider: llmSelection.llmProviderId ?? "(default)",
    model: llmSelection.llmModelName ?? "(default)",
    override_source: body.llm_override ? "request" : "session",
  });

  const stream = await processMessage({
    user: auth,
    chatSessionId,
    message: body.message,
    personaId: body.persona_id ?? undefined,
    signal: c.req.raw.signal,
    wireFormat: "ndjson",
    deepResearch: body.deep_research === true,
    ...llmSelection,
  });

  // NDJSON stream served with the original streaming content type
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
});

chatRoutes.post("/send-message", async (c) => {
  const auth = await getAuthContext(c);
  let body: z.infer<typeof sendMessageSchema>;
  try {
    body = sendMessageSchema.parse(await c.req.json());
  } catch (err) {
    throw new InvalidRequestError(
      `Invalid send-message request: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Auto-create the session when no id is given (port of create_chat_session_from_request).
  let chatSessionId = body.chat_session_id;
  if (!chatSessionId) {
    const personaId =
      body.persona_id ?? (await getDefaultPersona()).id;
    const session = await createChatSession(
      auth.user.id,
      personaId,
      body.message,
    );
    chatSessionId = session.id;
  }

  const stream = await processMessage({
    user: auth,
    chatSessionId,
    message: body.message,
    ...(body.persona_id !== undefined ? { personaId: body.persona_id } : {}),
  });

  // Server-Sent Events response: `data: <packet json>\n\n` frames with a
  // final `data: [DONE]\n\n` (produced by processMessage's stream).
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

chatRoutes.get("/sessions", async (c) => {
  const auth = await getAuthContext(c);
  const sessions = await listChatSessions(auth.user.id);
  return c.json({ sessions });
});

chatRoutes.get("/sessions/:id/messages", async (c) => {
  const auth = await getAuthContext(c);
  const sessionId = c.req.param("id");
  const session = await getChatSession(sessionId, auth.user.id);
  const messages = await getChatMessages(session.id);
  return c.json({ messages });
});

chatRoutes.delete("/sessions/:id", async (c) => {
  const auth = await getAuthContext(c);
  const sessionId = c.req.param("id");
  await deleteChatSession(sessionId, auth.user.id);
  return c.json({ success: true });
});

chatRoutes.post("/sessions/:id/stop", async (c) => {
  await getAuthContext(c);
  // The Python stop path relies on the run-store interruption machinery
  // (chat/run_store.py + stream_id reservation); not part of this port.
  throw new UnsupportedFeatureError(
    "Session stop is not implemented in the TypeScript port (501)",
  );
});

// Ownership enforcement helper retained for future session-mutation routes
// (port of get_chat_session_by_id's user check).
export async function requireOwnedSession(
  sessionId: string,
  userId: string,
): Promise<void> {
  const session = await getChatSession(sessionId, userId);
  if (session.deleted) {
    throw new ForbiddenError("Chat session is deleted");
  }
}
