/**
 * Hono auth middleware — port of the Onyx request-auth dependency chain:
 *   - /home/z/onyx/backend/onyx/auth/utils.py get_hashed_bearer_token_from_request
 *     (accepts "Bearer <key>" and the raw key, via the Authorization header,
 *     plus the X-Onyx-Authorization alternative header)
 *   - /home/z/onyx/backend/onyx/auth/session_tokens.py (cookie transport, cookie
 *     name FASTAPI_USERS_AUTH_COOKIE_NAME -> SESSION_COOKIE_NAME in this port)
 *   - /home/z/onyx/backend/onyx/auth/users.py current_user / current_chat_accessible_user
 *     (resolve credentials -> User, reject on missing/invalid)
 *   - /home/z/onyx/backend/onyx/auth/permissions.py require_permission / user_is_admin
 *     (admin gate for management surfaces)
 *
 * requireAuth resolves an API key (Authorization header) or a session cookie and
 * stores AuthContext on the Hono context as `c.set("auth", ...)`; requireAdmin
 * additionally requires role == "admin" (db/users.py user_is_admin semantics).
 */
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { SESSION_COOKIE_NAME } from "../configs/constants.js";
import { authenticateApiKey } from "./api_keys.js";
import { getSessionUser } from "./sessions.js";
import type { AuthContext } from "../types/domain.js";

// Make c.get("auth") / c.set("auth", ...) type-safe across the app.
declare module "hono" {
  interface ContextVariableMap {
    auth?: AuthContext;
  }
}

/**
 * Extract the API key from the request, port of get_hashed_bearer_token_from_request:
 * "Bearer <key>", the raw key in Authorization, or X-Onyx-Authorization.
 */
function extractApiKey(c: Context): string | undefined {
  for (const headerName of ["Authorization", "X-Onyx-Authorization"]) {
    const raw = c.req.header(headerName)?.trim();
    if (!raw) continue;
    const value = raw.startsWith("Bearer ") ? raw.slice("Bearer ".length).trim() : raw;
    if (value) return value;
  }
  return undefined;
}

/** Resolve AuthContext from (in order) bearer/API key and session cookie. */
async function resolveAuth(c: Context): Promise<AuthContext | undefined> {
  const apiKey = extractApiKey(c);
  if (apiKey) {
    const viaKey = await authenticateApiKey(apiKey);
    if (viaKey) return viaKey;
    // fall through to session auth, mirroring Onyx's layered token resolution
  }

  const sessionId = getCookie(c, SESSION_COOKIE_NAME);
  if (sessionId) {
    // Session ids are UUIDs (fastapi-users token semantics); a malformed
    // cookie must reject as unauthenticated (401), never 500 on a Postgres
    // uuid cast error.
    if (UUID_RE.test(sessionId)) {
      const user = await getSessionUser(sessionId);
      if (user) return { user, viaApiKey: false };
    }
  }
  return undefined;
}

// UUID v1-v8 tolerant pattern (any hex group layout Postgres accepts).
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function unauthorized(c: Context): Response {
  // Port of BasicAuthenticationError -> HTTPException(401, "Unauthorized"):
  // the exact fastapi-users body the original frontend expects.
  return c.json({ detail: "Unauthorized" }, 401);
}

function forbidden(c: Context): Response {
  // Port of HTTPException(403, ...) detail shape.
  return c.json({ detail: "You do not have permission to perform this action" }, 403);
}

/** Authenticated-request gate (fastapi_users current_user equivalent). */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const auth = await resolveAuth(c);
  if (!auth) {
    return unauthorized(c);
  }
  c.set("auth", auth);
  await next();
};

/** Admin-only gate (require_permission(Permission.ADMIN) equivalent). */
export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const auth = await resolveAuth(c);
  if (!auth) {
    return unauthorized(c);
  }
  // db/users.py user_is_admin: role ADMIN (group-based EE permissions not ported)
  if (auth.user.role !== "admin") {
    return forbidden(c);
  }
  c.set("auth", auth);
  await next();
};

/** Read the AuthContext set by requireAuth/requireAdmin (undefined before them). */
export function getAuth(c: Context): AuthContext | undefined {
  return c.get("auth");
}
