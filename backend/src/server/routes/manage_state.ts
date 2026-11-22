/**
 * Public state routes — TypeScript port of
 * backend/onyx/server/manage/get_state.py:
 *   GET /auth/type  (get_auth_type)  — public, Cache-Control varies on has_users
 *   GET /version    (get_version)    — public VersionResponse
 *
 * AuthConfigResponse shape (auth/schemas.py): multi_tenant, requires_verification,
 * anonymous_user_enabled, password_* rules from SecuritySettings env defaults,
 * has_users (live user count; Python latches True after first signup — we query
 * live, same observable result for a fresh deployment), oauth_enabled,
 * password_auth_enabled, sso_providers (empty list: no SSO configured),
 * default_language (workspace settings default: "en").
 */
import { Hono } from "hono";
import { queryOne } from "../../db/client";
import { AUTH_CONFIG, SETTINGS_DEFAULTS } from "../../configs/constants";
import { getLogger } from "../../utils/logger";

const logger = getLogger("routes.manage_state");

export const manageStateRoutes = new Hono();

manageStateRoutes.get("/auth/type", async (c) => {
  let hasUsers = true;
  try {
    const row = await queryOne<{ count: string }>(
      `SELECT count(*)::text AS count FROM onyx_user`,
    );
    hasUsers = Number(row?.count ?? "0") > 0;
  } catch (err) {
    logger.error("has_users count failed", { error: String(err) });
    hasUsers = true;
  }

  // Port of get_auth_type Cache-Control logic: cache only after bootstrap.
  c.header("Cache-Control", hasUsers ? "public, max-age=60" : "no-store");

  return c.json({
    multi_tenant: AUTH_CONFIG.multiTenant,
    requires_verification: AUTH_CONFIG.requiresVerification,
    anonymous_user_enabled: AUTH_CONFIG.anonymousUserEnabled,
    password_min_length: AUTH_CONFIG.passwordMinLength,
    password_max_length: AUTH_CONFIG.passwordMaxLength,
    password_require_uppercase: AUTH_CONFIG.passwordRequireUppercase,
    password_require_lowercase: AUTH_CONFIG.passwordRequireLowercase,
    password_require_digit: AUTH_CONFIG.passwordRequireDigit,
    password_require_special_char: AUTH_CONFIG.passwordRequireSpecialChar,
    has_users: hasUsers,
    oauth_enabled: AUTH_CONFIG.oauthEnabled,
    password_auth_enabled: AUTH_CONFIG.passwordAuthEnabled,
    sso_providers: [],
    default_language: "en",
  });
});

manageStateRoutes.get("/version", (c) => {
  // Port of VersionResponse(backend_version=__version__)
  return c.json({ backend_version: SETTINGS_DEFAULTS.backendVersion });
});
