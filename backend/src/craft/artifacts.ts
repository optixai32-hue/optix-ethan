/**
 * Owned by Task 2-d. Port of the craft artifact workspace backend.
 *
 * Python sources consulted:
 *   - /home/z/onyx/backend/onyx/db/models.py ("class Artifact", ~line 8183:
 *      artifact rows belong to a build session, carry created_at/updated_at,
 *      soft-delete flag; onyx-ts uses the 2-a table: id uuid,
 *      chat_session_id uuid NULL, title, content, created_at, updated_at)
 *   - /home/z/onyx/backend/onyx/db/artifact.py (DB CRUD helpers)
 *   - /home/z/onyx/backend/onyx/server/features/build/session/api.py
 *     (artifact endpoints: list per session, ownership checked against the
 *      session's user, NOT_FOUND for foreign sessions)
 *   - /home/z/onyx/backend/onyx/server/features/build/session/manager.py
 *     (SessionManager.list_artifacts: session-scoped artifact listing)
 *
 * DEVIATION — microVM runtime NOT ported: In Standard, craft artifacts are
 * files materialized inside per-session sandbox containers (build_session /
 * sandbox / ArtifactType / path / version columns) managed by the craft
 * runtime and reconciled by the reconcile-sandbox-runtimes beat task. onyx-ts
 * keeps only the DB-backed metadata/content CRUD (title + content on the
 * artifact row); there is no sandbox, no file-backed artifacts, and no
 * archive/serving layer.
 *
 * Ownership model (matches the 2-a schema, which has no user_id column):
 * artifacts attached to a chat_session are visible only to that session's
 * user (join on chat_session.user_id); artifacts with NULL chat_session_id
 * carry no recorded owner and are readable by any authenticated user.
 */
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/client";
import { ForbiddenError, InvalidRequestError, NotFoundError } from "../utils/errors";
import { getLogger } from "../utils/logger";
import type { Artifact } from "../types/domain";

const logger = getLogger("craft.artifacts");

export interface ArtifactInput {
  chatSessionId?: string;
  title: string;
  content: string;
}

export interface ArtifactPatch {
  title?: string;
  content?: string;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function assertUuid(value: string, what: string): void {
  if (!UUID_RE.test(value)) {
    throw new InvalidRequestError(`${what} must be a uuid, got: '${value}'`);
  }
}

/**
 * Ownership predicate: session-scoped artifacts require the session owner;
 * ownerless (NULL chat_session_id) artifacts are readable by anyone.
 * `userIdIdx` is the 1-based parameter index of the user id.
 */
function ownershipSql(userIdIdx: number): string {
  return `(a.chat_session_id IS NULL OR EXISTS (
     SELECT 1 FROM chat_session s
     WHERE s.id = a.chat_session_id AND s.user_id = $${userIdIdx}
   ))`;
}

function toArtifact(row: Artifact): Artifact {
  return row;
}

/** List artifacts visible to `userId`, optionally scoped to a chat session. */
export async function listArtifacts(
  userId: string,
  chatSessionId?: string,
): Promise<Artifact[]> {
  if (chatSessionId !== undefined) {
    assertUuid(chatSessionId, "chat_session_id");
    const res = await query<Artifact>(
      `SELECT a.id, a.chat_session_id, a.title, a.content, a.created_at, a.updated_at
       FROM artifact a
       WHERE a.chat_session_id = $2 AND ${ownershipSql(1)}
       ORDER BY a.created_at DESC`,
      [userId, chatSessionId],
    );
    return res.rows.map(toArtifact);
  }
  const res = await query<Artifact>(
    `SELECT a.id, a.chat_session_id, a.title, a.content, a.created_at, a.updated_at
     FROM artifact a
     WHERE ${ownershipSql(1)}
     ORDER BY a.created_at DESC`,
    [userId],
  );
  return res.rows.map(toArtifact);
}

/** Fetch one artifact if visible to `userId`. */
export async function getArtifact(userId: string, artifactId: string): Promise<Artifact> {
  assertUuid(artifactId, "artifact id");
  const row = await queryOne<Artifact>(
    `SELECT a.id, a.chat_session_id, a.title, a.content, a.created_at, a.updated_at
     FROM artifact a
     WHERE a.id = $2 AND ${ownershipSql(1)}`,
    [userId, artifactId],
  );
  if (!row) {
    throw new NotFoundError("Artifact");
  }
  return toArtifact(row);
}

/** Validate + authorize a chat_session_id for creation. */
async function assertChatSessionWritable(userId: string, chatSessionId: string): Promise<void> {
  assertUuid(chatSessionId, "chat_session_id");
  const session = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM chat_session WHERE id = $1 AND deleted = false`,
    [chatSessionId],
  );
  if (!session) {
    throw new NotFoundError("Chat session");
  }
  if (session.user_id !== userId) {
    throw new ForbiddenError("Chat session belongs to another user");
  }
}

/** Create an artifact (port of the build-session artifact creation surface). */
export async function createArtifact(userId: string, input: ArtifactInput): Promise<Artifact> {
  const title = input.title.trim();
  if (!title) {
    throw new InvalidRequestError("artifact title must not be empty");
  }
  if (typeof input.content !== "string") {
    throw new InvalidRequestError("artifact content must be a string");
  }
  if (input.chatSessionId !== undefined && input.chatSessionId !== null) {
    await assertChatSessionWritable(userId, input.chatSessionId);
  }
  const id = randomUUID();
  const row = await queryOne<Artifact>(
    `INSERT INTO artifact (id, chat_session_id, title, content)
     VALUES ($1, $2, $3, $4)
     RETURNING id, chat_session_id, title, content, created_at, updated_at`,
    [id, input.chatSessionId ?? null, title, input.content],
  );
  if (!row) {
    throw new Error("artifact insert returned no row");
  }
  logger.info("artifact created", { artifactId: row.id, userId, chatSessionId: row.chat_session_id });
  return toArtifact(row);
}

/** Update title/content of a visible artifact; stamps updated_at. */
export async function updateArtifact(
  userId: string,
  artifactId: string,
  patch: ArtifactPatch,
): Promise<Artifact> {
  assertUuid(artifactId, "artifact id");
  const sets: string[] = [];
  const params: unknown[] = [userId, artifactId];
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) {
      throw new InvalidRequestError("artifact title must not be empty");
    }
    params.push(title);
    sets.push(`title = $${params.length}`);
  }
  if (patch.content !== undefined) {
    params.push(patch.content);
    sets.push(`content = $${params.length}`);
  }
  if (sets.length === 0) {
    return getArtifact(userId, artifactId);
  }
  sets.push("updated_at = now()");
  const row = await queryOne<Artifact>(
    `UPDATE artifact a SET ${sets.join(", ")}
     WHERE a.id = $2 AND ${ownershipSql(1)}
     RETURNING a.id, a.chat_session_id, a.title, a.content, a.created_at, a.updated_at`,
    params,
  );
  if (!row) {
    throw new NotFoundError("Artifact");
  }
  return toArtifact(row);
}

/** Hard-delete one visible artifact. Returns true when a row was removed. */
export async function deleteArtifact(userId: string, artifactId: string): Promise<boolean> {
  assertUuid(artifactId, "artifact id");
  const res = await query<{ id: string }>(
    `DELETE FROM artifact a
     WHERE a.id = $2 AND ${ownershipSql(1)}
     RETURNING a.id`,
    [userId, artifactId],
  );
  return res.rows.length > 0;
}

/** Hard-delete many visible artifacts; returns the number removed. */
export async function deleteArtifacts(userId: string, artifactIds: string[]): Promise<number> {
  if (artifactIds.length === 0) return 0;
  for (const artifactId of artifactIds) {
    assertUuid(artifactId, "artifact id");
  }
  // Ownership can be a single predicate only against one row; delete per id
  // so a foreign id neither fails the batch nor deletes another user's row.
  let deleted = 0;
  for (const artifactId of artifactIds) {
    if (await deleteArtifact(userId, artifactId)) deleted += 1;
  }
  logger.info("artifacts deleted", { userId, requested: artifactIds.length, deleted });
  return deleted;
}
