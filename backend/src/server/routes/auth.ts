/**
 * Auth + API-key routes — TypeScript port of the Onyx auth surface:
 *   - /home/z/onyx/backend/onyx/main.py include_auth_router_with_prefix(fastapi_users...)
 *     (POST /auth/register, POST /auth/login, POST /auth/logout via fastapi_users routers)
 *   - /home/z/onyx/backend/onyx/auth/schemas.py (UserCreate/UserRead validation)
 *   - /home/z/onyx/backend/onyx/auth/users.py (UserManager: register + credentials login,
 *     LOGIN_BAD_CREDENTIALS / LOGIN_USER_DISABLED semantics)
 *   - /home/z/onyx/backend/onyx/auth/session_tokens.py CookieTransport
 *     (httpOnly session cookie; secure only on https)
 *   - /home/z/onyx/backend/onyx/server/api_key/api.py
 *     (GET/POST/DELETE /admin/api-key -> surfaced here as /auth/api-keys)
 *
 * First-boot flow: ensureDefaultAdmin() is kicked off (fire-and-forget) at route
 * registration time, mirroring Onyx's initial-tenant setup hook.
 */
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  SESSION_COOKIE_NAME,
  SESSION_EXPIRY_HOURS,
  AUTH_CONFIG,
} from "../../configs/constants";
import { getLogger } from "../../utils/logger";
import { AuthError, InvalidRequestError, NotFoundError } from "../../utils/errors";
import { createApiKey, listApiKeys, deleteApiKey } from "../../auth/api_keys";
import { createUser, getUserByEmail, ensureDefaultAdmin } from "../../auth/users";
import { createSession, deleteSession, extendSession, getSessionUser } from "../../auth/sessions";
import { verifyPassword } from "../../auth/password";
import { getAuth, requireAuth } from "../../auth/middleware";
import type { User } from "../../types/domain";

const logger = getLogger("routes.auth");

/**
 * Port of fastapi-users UserRead as Onyx serves it (auth/schemas.py UserRead):
 * { id, email, is_active, is_superuser, is_verified }.
 */
function publicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    is_active: user.is_active,
    // db/users.py user_is_admin semantics: role == "admin" maps to is_superuser
    is_superuser: user.role === "admin",
    is_verified: true, // REQUIRE_EMAIL_VERIFICATION disabled in this deployment
  };
}

/** zod body validation (UserCreate/UserRead schemas + APIKeyArgs equivalents). */
async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    raw = undefined;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new InvalidRequestError(`Invalid request body: ${detail}`);
  }
  return parsed.data;
}

function setSessionCookie(c: Context, sessionId: string): void {
  // Port of CookieTransport: cookie name fastapiusersauth, httpOnly, path=/,
  // lifetime = session lifetime (fastapi-users sets max_age = token lifetime).
  setCookie(c, SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    path: "/",
    sameSite: "Lax",
    secure: false, // Onyx derives this from WEB_DOMAIN https; this deployment is http
    maxAge: SESSION_EXPIRY_HOURS * 60 * 60,
  });
}

/**
 * Port of Onyx's password validator (auth/users.py UserManager._validate_password
 * against SecuritySettings): length bounds + optional complexity requirements.
 * FastAPI-Users error body: {"detail": {"code": "REGISTER_INVALID_PASSWORD", "reason": ...}}
 */
function validatePasswordOrThrow(password: string): void {
  const failures: string[] = [];
  if (password.length < AUTH_CONFIG.passwordMinLength) {
    failures.push(
      `Password must be at least ${AUTH_CONFIG.passwordMinLength} characters long.`,
    );
  }
  if (password.length > AUTH_CONFIG.passwordMaxLength) {
    failures.push(
      `Password must be at most ${AUTH_CONFIG.passwordMaxLength} characters long.`,
    );
  }
  if (AUTH_CONFIG.passwordRequireUppercase && !/[A-Z]/.test(password)) {
    failures.push("Password must contain an uppercase character.");
  }
  if (AUTH_CONFIG.passwordRequireLowercase && !/[a-z]/.test(password)) {
    failures.push("Password must contain a lowercase character.");
  }
  if (AUTH_CONFIG.passwordRequireDigit && !/[0-9]/.test(password)) {
    failures.push("Password must contain a digit.");
  }
  if (
    AUTH_CONFIG.passwordRequireSpecialChar &&
    !/[^A-Za-z0-9]/.test(password)
  ) {
    failures.push("Password must contain a special character.");
  }
  if (failures.length > 0) {
    throw new AuthError(
      400,
      JSON.stringify({ code: "REGISTER_INVALID_PASSWORD", reason: failures.join(" ") }),
    );
  }
}

export const authRoutes = new Hono();

// POST /auth/register — fastapi_users register router (UserCreate -> UserRead)
authRoutes.post("/register", async (c) => {
  const body = await parseBody(
    c,
    z.object({
      email: z.email(),
      username: z.string().optional(),
      password: z.string().min(1),
      referral_source: z.string().nullish(),
      captcha_token: z.string().nullish(),
    }),
  );
  validatePasswordOrThrow(body.password);
  const user = await createUser(body.email, body.password);
  return c.json(publicUser(user), 201);
});

// POST /auth/login — fastapi_users credentials router; sets the session cookie.
// The original frontend (web/src/lib/users/svc.ts basicLogin) posts
// application/x-www-form-urlencoded username=<email>&password=<password>,
// i.e. fastapi-users OAuth2PasswordRequestForm. CookieTransport responds 200
// with body "null" and the session cookie; failures are fastapi-users error
// codes: {"detail": "LOGIN_BAD_CREDENTIALS"} / {"detail": "LOGIN_USER_DISABLED"}.
authRoutes.post("/login", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  let email = "";
  let password = "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = await c.req.parseBody();
    email = typeof form["username"] === "string" ? form["username"] : "";
    password = typeof form["password"] === "string" ? form["password"] : "";
  } else {
    const body = await parseBody(
      c,
      z.object({
        username: z.string().optional(),
        email: z.string().optional(),
        password: z.string().min(1),
      }),
    );
    email = body.email ?? body.username ?? "";
    password = body.password;
  }

  if (!email || !password) {
    // OAuth2PasswordRequestForm requires both fields (422 in FastAPI when absent;
    // the original client never sends them empty, 400 keeps parity for misuse)
    throw new AuthError(400, "LOGIN_BAD_CREDENTIALS");
  }

  const user = await getUserByEmail(email);
  if (!user || !user.password_hash || !(await verifyPassword(password, user.password_hash))) {
    // LOGIN_BAD_CREDENTIALS: never reveal whether the email exists
    throw new AuthError(400, "LOGIN_BAD_CREDENTIALS");
  }
  if (!user.is_active) {
    // LOGIN_USER_DISABLED
    throw new AuthError(400, "LOGIN_USER_DISABLED");
  }

  const session = await createSession(user.id);
  setSessionCookie(c, session.id);
  logger.info("user logged in", { user_id: user.id });
  // fastapi-users CookieTransport returns None -> body "null"
  return c.json(null);
});

// GET /auth/me — fastapi_users /users/me equivalent
authRoutes.get("/me", requireAuth, (c) => {
  const auth = getAuth(c);
  if (!auth) {
    throw new InvalidRequestError("Authentication required");
  }
  return c.json(publicUser(auth.user));
});

// POST /auth/logout — fastapi_users logout: deletes the server-side session,
// clears the fastapiusersauth cookie, responds 200 null (CookieTransport).
authRoutes.post("/logout", async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE_NAME);
  if (sessionId) {
    await deleteSession(sessionId);
  }
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
  return c.json(null);
});

// POST /auth/refresh — port of FastAPIUsersWithRefreshRouter.get_refresh_router
// (auth/users.py:2129) with RefreshableDatabaseStrategy.refresh_token
// (auth/users.py:1977): extends the SAME session token's expiry in place and
// returns it unchanged. No rotation — in-flight requests carrying the current
// cookie must remain valid across the refresh (Python `return token`).
// The web client's useTokenRefresh ticker only checks response.ok; the OAuth
// token-refresh side of the original applies to OAuth-backed accounts, which
// this deployment does not configure.
authRoutes.post("/refresh", async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE_NAME);
  if (!sessionId) {
    return c.json({ detail: "Missing token or inactive user." }, 401);
  }
  const user = await getSessionUser(sessionId);
  if (!user || !user.is_active) {
    return c.json({ detail: "Missing token or inactive user." }, 401);
  }
  // Sliding window: bump expires_at on the existing row. If the row vanished
  // (logout/revoke raced the refresh) the token stays terminated — never mint
  // a replacement, mirroring the OnyxError(SESSION_TERMINATED) path.
  const extended = await extendSession(sessionId);
  if (!extended) {
    return c.json({ detail: "Missing token or inactive user." }, 401);
  }
  // Same token returned — refresh the cookie lifetime client-visible window.
  setSessionCookie(c, sessionId);
  return c.json(null);
});

// GET /auth/api-keys — port of GET /admin/api-key (scoped to the caller's keys)
authRoutes.get("/api-keys", requireAuth, async (c) => {
  const auth = getAuth(c);
  if (!auth) {
    throw new InvalidRequestError("Authentication required");
  }
  const keys = await listApiKeys(auth.user.id);
  return c.json(
    keys.map((key) => ({
      id: key.id,
      user_id: key.user_id,
      name: key.name,
      api_key_display: key.api_key_display,
      is_active: key.is_active,
      created_at: key.created_at,
    })),
  );
});

// POST /auth/api-keys — port of POST /admin/api-key (ApiKeyArgs { name });
// the full key is returned exactly once (ApiKeyDescriptor.api_key semantics)
authRoutes.post("/api-keys", requireAuth, async (c) => {
  const auth = getAuth(c);
  if (!auth) {
    throw new InvalidRequestError("Authentication required");
  }
  const body = await parseBody(c, z.object({ name: z.string().min(1).max(120) }));
  const { apiKey, key } = await createApiKey(auth.user.id, body.name);
  return c.json({
    id: apiKey.id,
    name: apiKey.name,
    api_key_display: apiKey.api_key_display,
    api_key: key,
    created_at: apiKey.created_at,
  });
});

// DELETE /auth/api-keys/:id — port of DELETE /admin/api-key/{id}, ownership-scoped
authRoutes.delete("/api-keys/:id", requireAuth, async (c) => {
  const auth = getAuth(c);
  if (!auth) {
    throw new InvalidRequestError("Authentication required");
  }
  const id = c.req.param("id");
  const deleted = await deleteApiKey(id, auth.user.id);
  if (!deleted) {
    throw new NotFoundError("API key");
  }
  logger.info("deleted api key", { api_key_id: id, user_id: auth.user.id });
  return c.json({ detail: "API key deleted" });
});

// First-boot bootstrap (Onyx initial_setup equivalent) — fire and forget.
ensureDefaultAdmin().catch((err: unknown) => {
  logger.error("default admin bootstrap failed", { error: String(err) });
});
