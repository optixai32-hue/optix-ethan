/**
 * Chat persistence — TypeScript port of backend/onyx/chat/persistence.py +
 * backend/onyx/db/chat.py (create_chat_session / get_chat_session_by_id /
 * create_new_chat_message / update_chat_message) and
 * backend/onyx/server/query_and_chat/chat_backend.py ::
 * _generate_or_fallback_chat_session_name + backend/onyx/secondary_llm_flows/
 * chat_session_naming.py :: get_fallback_chat_session_name +
 * generate_chat_session_name.
 *
 * SQL targets the chat tables owned by Task 2-a's migrations:
 *   chat_session(id uuid, user_id uuid, persona_id int, title, description,
 *                created_at, updated_at, deleted)
 *   chat_message(id serial, chat_session_id uuid, message text, role text,
 *                message_index int, citations jsonb, error text, created_at)
 *
 * Title policy (chat_session_naming.py verified in this checkout): the
 * fallback name derives from the first user message; the current Python uses a
 * 40-char fallback — this port truncates at 100 chars per the port contract,
 * keeping the "..." suffix and DEFAULT_CHAT_SESSION_NAME ("New Chat")
 * behaviors. When an LLM is available, the CHAT_NAMING prompts (verbatim from
 * onyx/prompts/chat_prompts.py lines 148-167) generate a concise name; any
 * failure falls back to the truncation, mirroring
 * _generate_or_fallback_chat_session_name's try/except.
 */

import { query, queryOne } from "../db/client.js";
import type { ChatMessage, ChatSession, Citation } from "../types/domain.js";
import { getLogger } from "../utils/logger.js";
import { ForbiddenError, NotFoundError } from "../utils/errors.js";
import { getLLMProvider } from "../llm/factory.js";
import type { LLMMessage } from "../llm/types.js";

const logger = getLogger("chat.persistence");

/** Port of DEFAULT_CHAT_SESSION_NAME (secondary_llm_flows/chat_session_naming.py). */
const DEFAULT_CHAT_SESSION_NAME = "New Chat";
/** Port contract deviation: Python uses 40; this port truncates at 100 chars. */
const FALLBACK_CHAT_SESSION_NAME_LENGTH = 100;

// Verbatim port of CHAT_NAMING_SYSTEM_PROMPT (onyx/prompts/chat_prompts.py).
const CHAT_NAMING_SYSTEM_PROMPT = `Given the conversation history, provide a SHORT name for the conversation. Focus the name on the important keywords to convey the topic of the conversation. Make sure the name is in the same language as the user's first message.

IMPORTANT: DO NOT OUTPUT ANYTHING ASIDE FROM THE NAME. MAKE IT AS CONCISE AS POSSIBLE. NEVER USE MORE THAN 5 WORDS, LESS IS FINE.`;

// Verbatim port of CHAT_NAMING_REMINDER (onyx/prompts/chat_prompts.py).
const CHAT_NAMING_REMINDER = `Provide a short name for the conversation. Refer to other messages in the conversation (not including this one) to determine the language of the name.

IMPORTANT: DO NOT OUTPUT ANYTHING ASIDE FROM THE NAME. MAKE IT AS CONCISE AS POSSIBLE. NEVER USE MORE THAN 5 WORDS, LESS IS FINE.`;

// Row types are type aliases (not interfaces) so they satisfy pg's
// QueryResultRow index-signature constraint.
type ChatSessionRow = {
  id: string;
  user_id: string;
  persona_id: number | null;
  title: string;
  description: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  deleted: boolean;
};

type ChatMessageRow = {
  id: number;
  chat_session_id: string;
  message: string;
  role: string;
  message_index: number;
  citations: Citation[] | null;
  error: string | null;
  created_at: Date | string;
};

function normalizeSession(row: ChatSessionRow): ChatSession {
  return {
    id: row.id,
    user_id: row.user_id,
    persona_id: row.persona_id,
    title: row.title,
    description: row.description,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    deleted: row.deleted,
  };
}

function normalizeMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    chat_session_id: row.chat_session_id,
    message: row.message,
    role: row.role === "assistant" ? "assistant" : "user",
    message_index: row.message_index,
    citations: row.citations,
    error: row.error,
    created_at: new Date(row.created_at),
  };
}

/** Truncate the first user message into a session title (chat_session_naming.py). */
export function getFallbackChatSessionName(firstUserMessage: string | null): string {
  const userMessage = (firstUserMessage ?? "").trim();
  if (!userMessage) return DEFAULT_CHAT_SESSION_NAME;
  if (userMessage.length <= FALLBACK_CHAT_SESSION_NAME_LENGTH) return userMessage;
  return userMessage.slice(0, FALLBACK_CHAT_SESSION_NAME_LENGTH).replace(/\s+$/, "") + "...";
}

/**
 * LLM-based session naming; any failure falls back to the truncation name
 * (port of _generate_or_fallback_chat_session_name's try/except).
 */
export async function generateChatSessionName(
  messages: Array<{ role: "user" | "assistant"; message: string }>,
  fallback: string,
): Promise<string> {
  try {
    const provider = await getLLMProvider(undefined, "default");
    const llmMessages: LLMMessage[] = [
      { role: "system", content: CHAT_NAMING_SYSTEM_PROMPT },
      ...messages.map(
        (m): LLMMessage => ({ role: m.role, content: m.message }),
      ),
      { role: "user", content: CHAT_NAMING_REMINDER },
    ];
    const response = await provider.complete(llmMessages, { maxTokens: 64 });
    const name = response.content.trim().replace(/^"+|"+$/g, "");
    return name || fallback;
  } catch (err) {
    logger.warning("chat session naming failed; using fallback", {
      error: String(err),
    });
    return fallback;
  }
}

/**
 * Create a session. `firstMessage` seeds the title via the Onyx fallback
 * truncation policy (first 100 chars); the LLM-based name is generated
 * opportunistically when `nameWithLlm` is set.
 */
export async function createChatSession(
  userId: string,
  personaId: number | null,
  firstMessage?: string,
  nameWithLlm = false,
): Promise<ChatSession> {
  const fallbackTitle = getFallbackChatSessionName(firstMessage ?? null);
  let title = fallbackTitle;
  if (nameWithLlm && firstMessage) {
    title = await generateChatSessionName(
      [{ role: "user", message: firstMessage }],
      fallbackTitle,
    );
  }
  const row = await queryOne<ChatSessionRow>(
    `INSERT INTO chat_session (user_id, persona_id, title, description, created_at, updated_at, deleted)
     VALUES ($1, $2, $3, '', now(), now(), false)
     RETURNING id, user_id, persona_id, title, description, created_at, updated_at, deleted`,
    [userId, personaId, title],
  );
  if (!row) {
    throw new Error("chat_session insert returned no row");
  }
  return normalizeSession(row);
}

/**
 * Fetch a session the user owns (port of get_chat_session_by_id's ownership
 * check — a foreign or deleted session is indistinguishable from absent).
 */
export async function getChatSession(
  chatSessionId: string,
  userId: string,
  includeDeleted = false,
): Promise<ChatSession> {
  const row = await queryOne<ChatSessionRow>(
    `SELECT id, user_id, persona_id, title, description, created_at, updated_at, deleted
     FROM chat_session WHERE id = $1`,
    [chatSessionId],
  );
  if (!row || (!includeDeleted && row.deleted)) {
    throw new NotFoundError("Chat session");
  }
  if (row.user_id !== userId) {
    throw new ForbiddenError("Chat session belongs to another user");
  }
  return normalizeSession(row);
}

/** List the user's non-deleted sessions, newest activity first. */
export async function listChatSessions(userId: string): Promise<ChatSession[]> {
  const res = await query<ChatSessionRow>(
    `SELECT id, user_id, persona_id, title, description, created_at, updated_at, deleted
     FROM chat_session
     WHERE user_id = $1 AND deleted = false
     ORDER BY updated_at DESC`,
    [userId],
  );
  return res.rows.map(normalizeSession);
}

/** Soft delete (port of delete_chat_session's non-hard-delete branch). */
export async function deleteChatSession(
  chatSessionId: string,
  userId: string,
): Promise<void> {
  const session = await getChatSession(chatSessionId, userId);
  await query(`UPDATE chat_session SET deleted = true WHERE id = $1`, [session.id]);
}

/**
 * Append a message; message_index = count of messages in the session
 * (task contract; equivalent to MAX(message_index)+1 for Onyx sessions,
 * which never delete individual messages).
 */
export async function appendChatMessage(
  chatSessionId: string,
  message: string,
  role: "user" | "assistant",
): Promise<ChatMessage> {
  const row = await queryOne<ChatMessageRow>(
    `WITH idx AS (
       SELECT COALESCE(COUNT(*), 0) AS next_index
       FROM chat_message WHERE chat_session_id = $1
     )
     INSERT INTO chat_message (chat_session_id, message, role, message_index, created_at)
     SELECT $1, $2, $3, idx.next_index, now() FROM idx
     RETURNING id, chat_session_id, message, role, message_index, citations, error, created_at`,
    [chatSessionId, message, role],
  );
  if (!row) {
    throw new Error("chat_message insert returned no row");
  }
  await query(`UPDATE chat_session SET updated_at = now() WHERE id = $1`, [
    chatSessionId,
  ]);
  return normalizeMessage(row);
}

/** Attach citations / error to a saved message (port of update_chat_message). */
export async function updateChatMessage(
  messageId: number,
  patch: { citations?: Citation[] | Record<string, string>; error?: string },
): Promise<void> {
  await query(
    `UPDATE chat_message SET
       citations = COALESCE($2::jsonb, citations),
       error = COALESCE($3, error)
     WHERE id = $1`,
    [
      messageId,
      patch.citations !== undefined ? JSON.stringify(patch.citations) : null,
      patch.error ?? null,
    ],
  );
}

/** Messages of a session in conversation order. */
export async function getChatMessages(chatSessionId: string): Promise<ChatMessage[]> {
  const res = await query<ChatMessageRow>(
    `SELECT id, chat_session_id, message, role, message_index, citations, error, created_at
     FROM chat_message
     WHERE chat_session_id = $1
     ORDER BY message_index ASC`,
    [chatSessionId],
  );
  return res.rows.map(normalizeMessage);
}
