/**
 * Session storage — TypeScript port of the Onyx session layer.
 *
 * Python sources:
 *   - /home/z/onyx/backend/onyx/auth/session_tokens.py
 *       (fastapi_users CookieTransport + Redis token strategy: logical expiry,
 *       expired-token rejection, logout/session termination)
 *   - /home/z/onyx/backend/onyx/configs/app_configs.py SESSION_EXPIRE_TIME_SECONDS
 *     (lifetime of the session credential)
 *
 * Standard Onyx keeps session tokens in Redis (`fastapi_users_token:<token>` keys)
 * and only a JWT/access-token table in Postgres. This port persists the session
 * server-side in the `user_session` table instead (documented deviation), keeping
 * the same observable behavior: opaque cookie value, fixed lifetime, expiry check
 * on every read, delete on logout, periodic purge of expired rows.
 */
import { query, queryOne } from "../db/client.js";
import { rowToUser, rowToUserSession } from "../db/models/rows.js";
import { SESSION_EXPIRY_HOURS } from "../configs/constants.js";
import { getLogger } from "../utils/logger.js";
import type { User, UserSession } from "../types/domain.js";

const logger = getLogger("auth.sessions");

/** Port of compute_session_expires_at / SESSION_EXPIRE_TIME_SECONDS (hours granularity here). */
export function computeSessionExpiry(): Date {
  return new Date(Date.now() + SESSION_EXPIRY_HOURS * 60 * 60 * 1000);
}

/**
 * Create a session (the fastapi_users login/cookie-transport equivalent):
 * opaque UUID stored server-side, returned to be set as the session cookie.
 */
export async function createSession(userId: string): Promise<UserSession> {
  const row = await queryOne<Record<string, unknown>>(
    `INSERT INTO user_session (user_id, expires_at)
     VALUES ($1, $2)
     RETURNING id, user_id, created_at, expires_at`,
    [userId, computeSessionExpiry()],
  );
  if (!row) {
    throw new Error("Failed to create user session");
  }
  return rowToUserSession(row);
}

/**
 * Port of classify_session_token_value + fastapi_users get_active_user:
 * resolves a session id to its active user, rejecting expired sessions
 * (SESSION_EXPIRED semantics) and deactivated users. Expired rows are
 * terminated eagerly, mirroring the logout tombstone cleanup.
 */
export async function getSessionUser(sessionId: string): Promise<User | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT u.*, s.id AS session_id, s.expires_at AS session_expires_at
     FROM user_session s
     JOIN onyx_user u ON u.id = s.user_id
     WHERE s.id = $1
     LIMIT 1`,
    [sessionId],
  );
  if (!row) return null;

  const expiresRaw = row["session_expires_at"];
  const expiresAt =
    expiresRaw instanceof Date
      ? expiresRaw
      : typeof expiresRaw === "string"
        ? new Date(expiresRaw)
        : null;
  if (expiresAt === null || Number.isNaN(expiresAt.getTime())) {
    // malformed row: treat as unrecognized session (MALFORMED rejection)
    await deleteSession(sessionId);
    return null;
  }

  if (expiresAt.getTime() <= Date.now()) {
    // SessionRejectionReason.EXPIRED: "Session expired. Please log in again."
    await deleteSession(sessionId);
    return null;
  }

  const user = rowToUser(row);
  if (!user.is_active) {
    // fastapi_users active-user gate: LOGIN_USER_DISABLED -> 400/401
    return null;
  }
  return user;
}

/**
 * Port of RefreshableDatabaseStrategy.refresh_token (auth/users.py:1977):
 * extends the SAME session row's expiry in place and keeps the same token.
 * Rotation (new row + delete old) is explicitly avoided — in-flight requests
 * carrying the current cookie must stay valid across a refresh, matching
 * the Python `return token` semantics.
 */
export async function extendSession(sessionId: string): Promise<boolean> {
  const res = await query<{ id: string }>(
    `UPDATE user_session
        SET expires_at = $2
      WHERE id = $1
        AND expires_at > now()
      RETURNING id`,
    [sessionId, computeSessionExpiry()],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Port of logout/session termination: remove the server-side session row. */
export async function deleteSession(sessionId: string): Promise<boolean> {
  const res = await query<{ id: string }>(
    `DELETE FROM user_session WHERE id = $1 RETURNING id`,
    [sessionId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Housekeeping port: expire stale session rows (SESSION_TOKEN_GRACE_PERIOD not kept). */
export async function purgeExpiredSessions(): Promise<number> {
  const res = await query<{ id: string }>(
    `DELETE FROM user_session WHERE expires_at < now() RETURNING id`,
  );
  const purged = res.rowCount ?? 0;
  if (purged > 0) {
    logger.info("purged expired sessions", { count: purged });
  }
  return purged;
}
