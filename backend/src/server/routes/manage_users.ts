/**
 * GET /me + PATCH /user/personalization — TypeScript port of
 * backend/onyx/server/manage/users.py verify_user_logged_in +
 * update_user_personalization_api, backed by the UserInfo schema
 * (backend/onyx/server/manage/models.py UserInfo / UserPreferences /
 * UserPersonalization / PersonalizationUpdateRequest).
 *
 * - Unauthenticated -> 401 {"detail": "Unauthorized"} (BasicAuthenticationError)
 * - Authenticated   -> full UserInfo shape consumed by web/src/lib/types.ts User
 * - personalization is persisted on onyx_user (personal_name, personal_role,
 *   use_memories, enable_memory_tool, user_preferences) + memory table
 *   (db/models.py User.440-446, Memory.585).
 *
 * Also hosts the EE user-management surface (server/manage/users.py): the admin
 * listings (/manage/users, /manage/users/accepted/all, /manage/users/invited,
 * /manage/users/download, /manage/users/counts), the user mutations
 * (activate/deactivate/delete/admin-access/invite) and the admin password
 * reset — request/response shapes follow web/src/views/admin/UsersPage/svc.ts.
 */
import { Hono, type Context } from "hono";
import { randomBytes } from "node:crypto";
import { getAuth, requireAdmin, requireAuth } from "../../auth/middleware";
import {
  adminCapabilities,
  getEffectivePermissions,
  Permission,
} from "../../auth/permissions";
import { hashPassword } from "../../auth/password";
import {
  createUser,
  getUserByEmail,
  recomputeUserPermissions,
} from "../../auth/users";
import { query, queryOne, withTransaction } from "../../db/client";
import { InvalidRequestError } from "../../utils/errors";
import type { User } from "../../types/domain";

export const manageUsersRoutes = new Hono();

interface PersonalizationRow {
  personal_name: string | null;
  personal_role: string | null;
  use_memories: boolean;
  enable_memory_tool: boolean;
  user_preferences: string | null;
}

interface MemoryRow {
  id: number;
  memory_text: string;
}

async function fetchPersonalization(userId: string): Promise<PersonalizationRow> {
  const row = await queryOne<PersonalizationRow>(
    `SELECT personal_name, personal_role, use_memories, enable_memory_tool, user_preferences
     FROM onyx_user WHERE id = $1`,
    [userId],
  );
  // Defaults mirror the SQLAlchemy column defaults (models.py:440-446).
  return (
    row ?? {
      personal_name: null,
      personal_role: null,
      use_memories: true,
      enable_memory_tool: true,
      user_preferences: null,
    }
  );
}

async function fetchMemories(userId: string): Promise<MemoryRow[]> {
  const res = await query<MemoryRow>(
    `SELECT id, memory_text FROM memory WHERE user_id = $1 ORDER BY created_at ASC, id ASC`,
    [userId],
  );
  return res.rows;
}

/**
 * Port of UserInfo.from_model (server/manage/models.py:205): the exact JSON
 * the original frontend expects from /api/me.
 */
export async function buildUserInfo(user: User): Promise<Record<string, unknown>> {
  const personalization = await fetchPersonalization(user.id);
  const memories = await fetchMemories(user.id);
  // Port of verify_user_logged_in: effective_permissions = sorted expanded
  // set; admin_capabilities = _admin_capabilities(effective, is_group_manager).
  const effective = getEffectivePermissions(user);
  const effectivePermissions = [...effective].sort();
  const isGroupManager = user.is_group_manager ?? false;
  // Stored UserPreferences (db/models.py User.preferences JSONB) merged over
  // the defaults — the original persists the whole dict on every preference
  // write (set_pinned_personas etc.).
  const prefRow = await queryOne<{ preferences: Record<string, unknown> | null }>(
    `SELECT preferences FROM onyx_user WHERE id = $1`,
    [user.id],
  );
  const stored = prefRow?.preferences ?? {};
  const preferences = {
    chosen_assistants: null,
    hidden_assistants: [],
    visible_assistants: [],
    default_model: null,
    pinned_assistants: [],
    shortcut_enabled: null,
    auto_scroll: null,
    temperature_override_enabled: null,
    temperature_default: null,
    reasoning_effort_default: null,
    theme_preference: null,
    language: null,
    chat_background: null,
    default_app_mode: "CHAT",
    paste_as_tile: null,
    interrupt_on_send: false,
    voice_auto_send: null,
    voice_auto_playback: null,
    voice_playback_speed: null,
    ...(stored as Record<string, unknown>),
  };
  return {
    id: user.id,
    email: user.email,
    is_active: user.is_active,
    is_superuser: user.role === "admin",
    is_verified: true,
    account_type: "STANDARD",
    preferences,
    // UserPersonalization (server/manage/models.py:174)
    personalization: {
      name: personalization.personal_name ?? "",
      role: personalization.personal_role ?? "",
      use_memories: personalization.use_memories,
      enable_memory_tool: personalization.enable_memory_tool,
      memories: memories.map((m) => ({ id: m.id, content: m.memory_text })),
      user_preferences: personalization.user_preferences ?? "",
    },
    token_expires_at: null,
    is_cloud_superuser: false,
    team_name: null,
    is_anonymous_user: null,
    password_configured: user.password_hash !== null,
    tenant_info: null,
    effective_permissions: effectivePermissions,
    is_group_manager: isGroupManager,
    admin_capabilities: adminCapabilities(effectivePermissions, isGroupManager),
  };
}

manageUsersRoutes.get("/me", requireAuth, async (c) => {
  const auth = getAuth(c);
  if (!auth) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  return c.json(await buildUserInfo(auth.user));
});

// PATCH /user/personalization — port of server/manage/users.py
// update_user_personalization_api + PersonalizationUpdateRequest
// (server/manage/models.py): every field optional, others preserved.
manageUsersRoutes.patch("/user/personalization", requireAuth, async (c) => {
  const auth = getAuth(c);
  if (!auth) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  const user = auth.user;
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  // Field-level None-vs-absent handling mirrors Pydantic's `| None = None`:
  // absent -> keep current value.
  const current = await fetchPersonalization(user.id);
  const name = typeof body.name === "string" ? body.name : current.personal_name;
  const role = typeof body.role === "string" ? body.role : current.personal_role;
  const useMemories =
    typeof body.use_memories === "boolean" ? body.use_memories : current.use_memories;
  const enableMemoryTool =
    typeof body.enable_memory_tool === "boolean"
      ? body.enable_memory_tool
      : current.enable_memory_tool;
  const userPreferences =
    typeof body.user_preferences === "string"
      ? body.user_preferences
      : current.user_preferences;

  await query(
    `UPDATE onyx_user
     SET personal_name = $2, personal_role = $3, use_memories = $4,
         enable_memory_tool = $5, user_preferences = $6, updated_at = now()
     WHERE id = $1`,
    [user.id, name, role, useMemories, enableMemoryTool, userPreferences],
  );

  // memories: when provided, replace the user's memory rows (port of
  // update_user_personalization's memories replacement).
  if (Array.isArray(body.memories)) {
    const items = body.memories as { id?: number; content?: string }[];
    await query(`DELETE FROM memory WHERE user_id = $1`, [user.id]);
    for (const item of items) {
      if (typeof item.content === "string" && item.content.length > 0) {
        await query(
          `INSERT INTO memory (user_id, memory_text) VALUES ($1, $2)`,
          [user.id, item.content],
        );
      }
    }
  }

  // FastAPI returns None -> JSON `null`.
  return c.json(null);
});

// PATCH /user/pinned-assistants — port of server/manage/users.py
// set_pinned_assistants_api (ReorderPinnedAssistantsRequest): replaces the
// user's ordered pinned-agent list; sidebar order follows the array order.
manageUsersRoutes.patch("/user/pinned-assistants", requireAuth, async (c) => {
  const auth = getAuth(c);
  if (!auth) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    ordered_assistant_ids?: unknown;
  };
  if (!Array.isArray(body.ordered_assistant_ids)) {
    return c.json({ detail: "ordered_assistant_ids is required" }, 422);
  }
  const pinned = body.ordered_assistant_ids.map((id) => Number(id));
  const prefRow = await queryOne<{ preferences: Record<string, unknown> | null }>(
    `SELECT preferences FROM onyx_user WHERE id = $1`,
    [auth.user.id],
  );
  const merged = { ...(prefRow?.preferences ?? {}), pinned_assistants: pinned };
  await query(
    `UPDATE onyx_user SET preferences = $2::jsonb, updated_at = now() WHERE id = $1`,
    [auth.user.id, JSON.stringify(merged)],
  );
  return c.json(null);
});

// PATCH /user/default-model — port of server/manage/users.py
// set_user_default_model_api (web/src/lib/users/svc.ts setUserDefaultModel ->
// PATCH /api/user/default-model {default_model}). The value is the
// "<provider_id>::<model_configuration_id>" descriptor string the frontend
// parses (getValidLlmDescriptorForProviders) or null to reset.
manageUsersRoutes.patch("/user/default-model", requireAuth, async (c) => {
  const auth = getAuth(c);
  if (!auth) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    default_model?: unknown;
  };
  const value = body.default_model === null ? null : typeof body.default_model === "string" ? body.default_model : null;
  const prefRow = await queryOne<{ preferences: Record<string, unknown> | null }>(
    `SELECT preferences FROM onyx_user WHERE id = $1`,
    [auth.user.id],
  );
  const merged = { ...(prefRow?.preferences ?? {}), default_model: value };
  await query(
    `UPDATE onyx_user SET preferences = $2::jsonb, updated_at = now() WHERE id = $1`,
    [auth.user.id, JSON.stringify(merged)],
  );
  return c.json(null);
});

// PATCH /user/default-app-mode — port of server/manage/users.py
// set_user_default_app_mode_api (web/src/providers/UserProvider.tsx
// updateUserDefaultAppMode -> PATCH /api/user/default-app-mode
// {default_app_mode: "CHAT" | "SEARCH"}).
manageUsersRoutes.patch("/user/default-app-mode", requireAuth, async (c) => {
  const auth = getAuth(c);
  if (!auth) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    default_app_mode?: unknown;
  };
  const mode = body.default_app_mode === "SEARCH" ? "SEARCH" : "CHAT";
  const prefRow = await queryOne<{ preferences: Record<string, unknown> | null }>(
    `SELECT preferences FROM onyx_user WHERE id = $1`,
    [auth.user.id],
  );
  const merged = { ...(prefRow?.preferences ?? {}), default_app_mode: mode };
  await query(
    `UPDATE onyx_user SET preferences = $2::jsonb, updated_at = now() WHERE id = $1`,
    [auth.user.id, JSON.stringify(merged)],
  );
  return c.json(null);
});

// GET /user/assistant/preferences — port of server/manage/users.py
// get_user_assistant_preferences: dict<assistant_id,
// {disabled_tool_ids, disabled_integration_ids}>. Fresh deployment: {}.
manageUsersRoutes.get("/user/assistant/preferences", requireAuth, (c) => {
  return c.json({});
});

// ---------------------------------------------------------------------------
// EE: users admin listing + administration (port of server/manage/users.py user
// management read/mutation surface). The web frontend hits:
//   - GET /manage/users?include_api_keys=true  -> AllUsersResponse
//     (web/src/lib/types.ts AllUsersResponse; rows follow FullUserSnapshot in
//      web/src/views/admin/UsersPage/types.ts — the group create/edit pages
//      build their member picker from this, including group managers who only
//      hold the scoped READ_USERS permission)
//   - GET /manage/users/accepted/all           -> FullUserSnapshot[]
//     (web/src/hooks/useAdminUsers.ts on SWR_KEYS.acceptedUsers — admin-only)
//   - GET /manage/users/invited                -> InvitedUserSnapshot[]
//     ({email}[]; admin-only; no invite flow in this port, always [])
//   - GET /manage/users/download               -> users CSV (admin-only)
//   - GET /manage/users/counts                 -> status/account-type tallies
//     (web/src/hooks/useUserCounts.ts UserCountsResponse)
//   - PATCH /manage/admin/deactivate-user / activate-user, DELETE
//     /manage/admin/delete-user, PATCH /manage/admin/users/admin-access,
//     PUT /manage/admin/users (invite), PATCH /manage/admin/remove-invited-user
//     (all admin-only; bodies per web/src/views/admin/UsersPage/svc.ts)
//   - POST /password/reset_password            -> { user_id, new_password }
//   - GET /tenants/users/pending               -> InvitedUserSnapshot[] (always [])
// ---------------------------------------------------------------------------

/** Port of the READ_USERS gate: admins, curators and group managers pass. */
function canListUsers(user: User): boolean {
  if (user.role === "admin") return true;
  const effective = getEffectivePermissions(user);
  return (
    effective.has(Permission.READ_USERS) ||
    effective.has(Permission.MANAGE_USER_GROUPS) ||
    (user.is_group_manager ?? false)
  );
}

interface UserAdminRow {
  id: string;
  email: string;
  role: string;
  is_active: boolean;
  password_configured: boolean;
  personal_name: string | null;
  personal_role: string | null;
  effective_permissions: string[] | null;
  is_group_manager: boolean;
  created_at: Date;
  updated_at: Date;
}

interface ApiKeyRow {
  id: string;
  user_id: string | null;
  name: string;
  api_key_display: string;
  created_at: Date | null;
}

interface AdminUserList {
  users: UserAdminRow[];
  lastActiveByUser: Map<string, Date>;
  groupsByUser: Map<string, { id: number; name: string }[]>;
}

/** Shared list SQL for the admin user surface (rows + last_active + groups). */
async function fetchAdminUserList(): Promise<AdminUserList> {
  const usersRes = await query<UserAdminRow>(
    `SELECT id, email, role, is_active,
            (password_hash IS NOT NULL) AS password_configured,
            personal_name, personal_role, effective_permissions,
            is_group_manager, created_at, updated_at
     FROM onyx_user
     ORDER BY created_at ASC, id ASC`,
  );

  // Most recent chat activity per user (last_active on FullUserSnapshot:
  // "Most recent chat activity; null when the user has never chatted").
  const lastActiveRes = await query<{ user_id: string | null; last_active: Date }>(
    `SELECT s.user_id, MAX(m.created_at) AS last_active
     FROM chat_message m
     JOIN chat_session s ON s.id = m.chat_session_id
     WHERE s.user_id IS NOT NULL
     GROUP BY s.user_id`,
  );
  const lastActiveByUser = new Map(
    lastActiveRes.rows.map((r) => [r.user_id as string, r.last_active]),
  );

  // Membership map (UserGroupInfo[]: { id, name }).
  const groupsRes = await query<{
    user_id: string;
    group_id: number;
    group_name: string;
  }>(
    `SELECT m.user_id, g.id AS group_id, g.name AS group_name
     FROM user__user_group m
     JOIN user_group g ON g.id = m.user_group_id
     ORDER BY g.id ASC`,
  );
  const groupsByUser = new Map<string, { id: number; name: string }[]>();
  for (const row of groupsRes.rows) {
    const list = groupsByUser.get(row.user_id) ?? [];
    list.push({ id: row.group_id, name: row.group_name });
    groupsByUser.set(row.user_id, list);
  }

  return { users: usersRes.rows, lastActiveByUser, groupsByUser };
}

manageUsersRoutes.get("/manage/users", requireAuth, async (c) => {
  const auth = getAuth(c);
  if (!auth) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  if (!canListUsers(auth.user)) {
    return c.json(
      { detail: "You do not have permission to perform this action" },
      403,
    );
  }
  const includeApiKeys = c.req.query("include_api_keys") === "true";

  const { users, lastActiveByUser, groupsByUser } = await fetchAdminUserList();

  // API keys per user, only requested via ?include_api_keys=true.
  const apiKeysByUser = new Map<string, Record<string, unknown>[]>();
  if (includeApiKeys) {
    const keysRes = await query<ApiKeyRow>(
      `SELECT id, user_id, name, api_key_display, created_at
       FROM api_key
       WHERE is_active
       ORDER BY created_at ASC`,
    );
    for (const key of keysRes.rows) {
      if (!key.user_id) continue;
      const list = apiKeysByUser.get(key.user_id) ?? [];
      list.push({
        id: key.id,
        name: key.name,
        api_key_display: key.api_key_display,
        created_at: key.created_at?.toISOString() ?? null,
      });
      apiKeysByUser.set(key.user_id, list);
    }
  }

  const accepted = users.map((row) => {
    const effective = getEffectivePermissions({
      effective_permissions: row.effective_permissions ?? [],
      is_anonymous_user: false,
    });
    return {
      id: row.id,
      email: row.email,
      account_type: "STANDARD",
      is_admin: row.role === "admin",
      role: row.role,
      is_active: row.is_active,
      password_configured: row.password_configured,
      personal_name: row.personal_name,
      personal_role: row.personal_role,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
      last_active: lastActiveByUser.get(row.id)?.toISOString() ?? null,
      groups: groupsByUser.get(row.id) ?? [],
      is_scim_synced: false,
      craft_enabled: null,
      // Extra fields (task spec) the admin Users page may read with fallbacks.
      effective_permissions: [...effective].sort(),
      is_group_manager: row.is_group_manager,
      is_superuser: row.role === "admin",
      is_verified: true,
      api_keys: apiKeysByUser.get(row.id) ?? [],
    };
  });

  // AllUsersResponse shape (web/src/lib/types.ts:150). No invite flow and no
  // Slack connector in this port, so invited/slack stay empty.
  return c.json({
    accepted,
    invited: [],
    slack_users: [],
    accepted_pages: 1,
    invited_pages: 1,
    slack_users_pages: 1,
  });
});

// GET /manage/users/accepted/all — admin-only accepted-user list consumed
// directly as FullUserSnapshot[] (useAdminUsers.ts useSWR<FullUserSnapshot[]>
// on SWR_KEYS.acceptedUsers; item shape = web/src/views/admin/UsersPage/types.ts
// FullUserSnapshot). The original endpoint is require_admin — group managers
// fall back to GET /manage/users instead.
manageUsersRoutes.get("/manage/users/accepted/all", requireAdmin, async (c) => {
  const { users, lastActiveByUser, groupsByUser } = await fetchAdminUserList();
  return c.json(
    users.map((row) => ({
      id: row.id,
      email: row.email,
      account_type: "STANDARD" as const,
      is_admin: row.role === "admin",
      is_active: row.is_active,
      password_configured: row.password_configured,
      personal_name: row.personal_name,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
      last_active: lastActiveByUser.get(row.id)?.toISOString() ?? null,
      groups: groupsByUser.get(row.id) ?? [],
      is_scim_synced: false,
      craft_enabled: null,
    })),
  );
});

// GET /manage/users/invited — admin-only invited list, consumed as
// InvitedUserSnapshot[] ({ email }[] — web/src/lib/types.ts). There is no
// invite flow in this port, so the list is always empty.
manageUsersRoutes.get("/manage/users/invited", requireAdmin, (c) => {
  return c.json([]);
});

// GET /manage/users/download — users CSV (svc.ts downloadUsersCsv fetches the
// blob and names it onyx_users_<timestamp>.csv client-side). Header row plus
// one line per user from the same list as GET /manage/users.
manageUsersRoutes.get("/manage/users/download", requireAdmin, async (c) => {
  const list = await fetchAdminUserList();
  return new Response(buildUsersCsv(list), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="onyx_users.csv"`,
    },
  });
});

manageUsersRoutes.get("/manage/users/counts", requireAuth, async (c) => {
  const auth = getAuth(c);
  if (!auth) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  if (!canListUsers(auth.user)) {
    return c.json(
      { detail: "You do not have permission to perform this action" },
      403,
    );
  }
  const countsRes = await query<{
    total: string;
    active: string;
    inactive: string;
    admins: string;
  }>(
    `SELECT count(*)                                                        AS total,
            count(*) FILTER (WHERE is_active)                               AS active,
            count(*) FILTER (WHERE NOT is_active)                           AS inactive,
            count(*) FILTER (WHERE role = 'admin')                          AS admins
     FROM onyx_user`,
  );
  const row = countsRes.rows[0];
  const total = Number(row?.total ?? 0);
  const active = Number(row?.active ?? 0);
  const inactive = Number(row?.inactive ?? 0);
  const admins = Number(row?.admins ?? 0);
  return c.json({
    // UserCountsResponse (web/src/hooks/useUserCounts.ts:10) — the keys the
    // UsersPage filter badges read.
    account_type_counts: { STANDARD: total },
    status_counts: {
      active,
      inactive,
      invited: 0,
      requested: 0,
    },
    // Extra convenience tallies (task spec).
    total,
    active,
    invited: 0,
    admins,
  });
});

// ---------------------------------------------------------------------------
// EE: user-management mutations + admin password reset (port of
// server/manage/users.py deactivate_user / activate_user / delete_user /
// change_user_role / invite_users and the admin reset-password action).
// Request shapes follow web/src/views/admin/UsersPage/svc.ts verbatim:
//   - PATCH|POST /manage/admin/deactivate-user     body { user_email }
//   - PATCH|POST /manage/admin/activate-user       body { user_email }
//   - DELETE|POST /manage/admin/delete-user        body { user_email }
//   - PATCH|POST /manage/admin/users/admin-access  body { user_email, is_admin }
//   - PUT|POST /manage/admin/users (invite)        body { emails: string[] }
//   - PATCH|POST /manage/admin/remove-invited-user body { user_email }
//   - POST /password/reset_password                body { user_email }
// All of these are require_admin (the mutations are admin-only in the original);
// failures are {"detail": ...} so svc.ts parseErrorDetail can surface them.
// ---------------------------------------------------------------------------

// Valid-enough email gate for auto-created accounts (port of is_valid_email).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Unambiguous alphabet for generated passwords (upper+lower+digit, no lookalikes).
const RANDOM_PASSWORD_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** 24-char random password for created/reset accounts (bcrypt-hashed before storage). */
function generateRandomPassword(): string {
  const bytes = randomBytes(24);
  let password = "";
  for (const byte of bytes) {
    password += RANDOM_PASSWORD_ALPHABET[byte % RANDOM_PASSWORD_ALPHABET.length];
  }
  return password;
}

/** Parse the `{ user_email: string }` body shared by the admin mutation endpoints. */
async function readUserEmailBody(c: Context): Promise<string> {
  const body = (await c.req.json().catch(() => ({}))) as { user_email?: unknown };
  const email = typeof body.user_email === "string" ? body.user_email.trim() : "";
  if (!email) {
    throw new InvalidRequestError("user_email is required");
  }
  return email;
}

/** Port of db/users.py get_all_admin_users, reduced to a count. */
async function countAdmins(): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM onyx_user WHERE role = 'admin'`,
  );
  return Number(row?.count ?? 0);
}

/** Port of db/auth.py get_active_admin_users, reduced to a count. */
async function countActiveAdmins(): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM onyx_user WHERE role = 'admin' AND is_active`,
  );
  return Number(row?.count ?? 0);
}

/** RFC 4180 cell escaping for the users CSV download. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Users CSV for GET /manage/users/download (header row + one line per user). */
function buildUsersCsv(list: AdminUserList): string {
  const header = [
    "id",
    "email",
    "personal_name",
    "groups",
    "is_admin",
    "is_active",
    "last_active",
    "created_at",
    "updated_at",
  ];
  const lines = [header.join(",")];
  for (const row of list.users) {
    lines.push(
      [
        row.id,
        row.email,
        row.personal_name ?? "",
        (list.groupsByUser.get(row.id) ?? []).map((g) => g.name).join(", "),
        row.role === "admin" ? "true" : "false",
        row.is_active ? "true" : "false",
        list.lastActiveByUser.get(row.id)?.toISOString() ?? "",
        row.created_at.toISOString(),
        row.updated_at.toISOString(),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

// PATCH|POST /manage/admin/deactivate-user — body { user_email } (svc.ts
// deactivateUser). Port of deactivate_user: refuses self-deactivation and the
// last active admin.
async function deactivateUserHandler(c: Context) {
  const auth = getAuth(c);
  if (!auth) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  const email = await readUserEmailBody(c);
  const target = await getUserByEmail(email);
  if (!target) {
    return c.json({ detail: `User with email ${email} does not exist` }, 400);
  }
  if (target.id === auth.user.id) {
    return c.json({ detail: "Cannot deactivate yourself" }, 400);
  }
  if (target.role === "admin" && target.is_active) {
    const activeAdmins = await countActiveAdmins();
    if (activeAdmins <= 1) {
      return c.json({ detail: "Cannot deactivate the last active admin" }, 400);
    }
  }
  await query(
    `UPDATE onyx_user SET is_active = false, updated_at = now() WHERE id = $1`,
    [target.id],
  );
  return c.json(null);
}
manageUsersRoutes.patch(
  "/manage/admin/deactivate-user",
  requireAdmin,
  deactivateUserHandler,
);
manageUsersRoutes.post(
  "/manage/admin/deactivate-user",
  requireAdmin,
  deactivateUserHandler,
);

// PATCH|POST /manage/admin/activate-user — body { user_email } (svc.ts
// activateUser). Port of activate_user.
async function activateUserHandler(c: Context) {
  const auth = getAuth(c);
  if (!auth) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  const email = await readUserEmailBody(c);
  const target = await getUserByEmail(email);
  if (!target) {
    return c.json({ detail: `User with email ${email} does not exist` }, 400);
  }
  await query(
    `UPDATE onyx_user SET is_active = true, updated_at = now() WHERE id = $1`,
    [target.id],
  );
  return c.json(null);
}
manageUsersRoutes.patch(
  "/manage/admin/activate-user",
  requireAdmin,
  activateUserHandler,
);
manageUsersRoutes.post(
  "/manage/admin/activate-user",
  requireAdmin,
  activateUserHandler,
);

// DELETE|POST /manage/admin/delete-user — body { user_email } (svc.ts
// deleteUser). Port of delete_user: refuses self-deletion and the last admin;
// clears group memberships, API keys and sessions before the user row itself.
async function deleteUserHandler(c: Context) {
  const auth = getAuth(c);
  if (!auth) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  const email = await readUserEmailBody(c);
  const target = await getUserByEmail(email);
  if (!target) {
    return c.json({ detail: `User with email ${email} does not exist` }, 400);
  }
  if (target.id === auth.user.id) {
    return c.json({ detail: "Cannot delete yourself" }, 400);
  }
  if (target.role === "admin") {
    const admins = await countAdmins();
    if (admins <= 1) {
      return c.json({ detail: "Cannot delete the last admin" }, 400);
    }
  }
  await withTransaction(async (client) => {
    await client.query(`DELETE FROM user__user_group WHERE user_id = $1`, [
      target.id,
    ]);
    await client.query(`DELETE FROM api_key WHERE user_id = $1`, [target.id]);
    await client.query(`DELETE FROM user_session WHERE user_id = $1`, [
      target.id,
    ]);
    await client.query(`DELETE FROM onyx_user WHERE id = $1`, [target.id]);
  });
  return c.json(null);
}
manageUsersRoutes.delete(
  "/manage/admin/delete-user",
  requireAdmin,
  deleteUserHandler,
);
manageUsersRoutes.post(
  "/manage/admin/delete-user",
  requireAdmin,
  deleteUserHandler,
);

// PATCH|POST /manage/admin/users/admin-access — body { user_email, is_admin }
// (svc.ts setUserAdminAccess). Port of change_user_role: flips the role and
// swaps the default-group membership (Admin <-> Basic), then recomputes
// effective_permissions from the group grants.
async function setUserAdminAccessHandler(c: Context) {
  const auth = getAuth(c);
  if (!auth) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    user_email?: unknown;
    is_admin?: unknown;
  };
  const email = typeof body.user_email === "string" ? body.user_email.trim() : "";
  if (!email || typeof body.is_admin !== "boolean") {
    throw new InvalidRequestError("user_email and is_admin are required");
  }
  const isAdmin = body.is_admin;
  const target = await getUserByEmail(email);
  if (!target) {
    return c.json({ detail: `User with email ${email} does not exist` }, 400);
  }
  if (!isAdmin && target.id === auth.user.id) {
    return c.json({ detail: "Cannot revoke your own admin access" }, 400);
  }
  if (!isAdmin && target.role === "admin") {
    const admins = await countAdmins();
    if (admins <= 1) {
      return c.json({ detail: "Cannot revoke the last admin" }, 400);
    }
  }
  const role = isAdmin ? "admin" : "basic";
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE onyx_user SET role = $2, updated_at = now() WHERE id = $1`,
      [target.id, role],
    );
    // Swap the default-group membership to mirror the role (port of
    // assign_user_to_default_groups__no_commit): drop the previous default
    // group, add the new one, then recompute effective_permissions below.
    await client.query(
      `DELETE FROM user__user_group m
       USING user_group g
       WHERE m.user_group_id = g.id AND m.user_id = $1
         AND g.is_default AND g.name = $2`,
      [target.id, isAdmin ? "Basic" : "Admin"],
    );
    await client.query(
      `INSERT INTO user__user_group (user_id, user_group_id)
       SELECT $1, g.id FROM user_group g
       WHERE g.name = $2 AND g.is_default
       ON CONFLICT (user_id, user_group_id) DO NOTHING`,
      [target.id, isAdmin ? "Admin" : "Basic"],
    );
  });
  // recompute_user_permissions__no_commit port (src/auth/users.ts helper).
  await recomputeUserPermissions(target.id);
  return c.json(null);
}
manageUsersRoutes.patch(
  "/manage/admin/users/admin-access",
  requireAdmin,
  setUserAdminAccessHandler,
);
manageUsersRoutes.post(
  "/manage/admin/users/admin-access",
  requireAdmin,
  setUserAdminAccessHandler,
);

// PUT|POST /manage/admin/users — body { emails: string[] } (svc.ts
// inviteUsers). Port of invite_users without the email-delivery flow: each
// address gets a real, active account immediately (role admin per this
// deployment's all-admin policy) with a random password; the admin hands the
// credentials over via the reset-password action. Known addresses are reported
// instead of duplicated (original's dedupe), under the InviteUsersResponse keys
// the original client ignores.
async function inviteUsersHandler(c: Context) {
  const body = (await c.req.json().catch(() => ({}))) as { emails?: unknown };
  if (!Array.isArray(body.emails)) {
    return c.json({ detail: "emails is required" }, 422);
  }
  const emails: string[] = [];
  const seen = new Set<string>();
  for (const raw of body.emails) {
    if (typeof raw !== "string") continue;
    const email = raw.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    if (!EMAIL_RE.test(email)) {
      return c.json({ detail: "Invalid email" }, 400);
    }
    seen.add(email);
    emails.push(email);
  }
  const users: { id: string; email: string; is_active: boolean }[] = [];
  for (const email of emails) {
    const existing = await getUserByEmail(email);
    if (existing) {
      users.push({
        id: existing.id,
        email: existing.email,
        is_active: existing.is_active,
      });
      continue;
    }
    const user = await createUser(email, generateRandomPassword(), {
      role: "admin",
      isActive: true,
    });
    users.push({ id: user.id, email: user.email, is_active: user.is_active });
  }
  return c.json({ invited_users: [], users });
}
manageUsersRoutes.put("/manage/admin/users", requireAdmin, inviteUsersHandler);
manageUsersRoutes.post("/manage/admin/users", requireAdmin, inviteUsersHandler);

// PATCH|POST /manage/admin/remove-invited-user — body { user_email } (svc.ts
// cancelInvite). There is no invite table in this port (accounts are created
// synchronously by PUT /manage/admin/users), so the request is acknowledged and
// its body ignored.
async function removeInvitedUserHandler(c: Context) {
  await c.req.json().catch(() => ({}));
  return c.json({ ok: true });
}
manageUsersRoutes.patch(
  "/manage/admin/remove-invited-user",
  requireAdmin,
  removeInvitedUserHandler,
);
manageUsersRoutes.post(
  "/manage/admin/remove-invited-user",
  requireAdmin,
  removeInvitedUserHandler,
);

// POST /password/reset_password — admin password reset (svc.ts resetPassword,
// body { user_email }): mints a fresh random password, replaces password_hash
// and returns { user_id, new_password } for the reveal modal
// (UserActionModals.tsx). Mirrors the admin-reset password_helper path
// (PasswordHelper.hash -> bcrypt).
async function resetPasswordHandler(c: Context) {
  const auth = getAuth(c);
  if (!auth) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  const email = await readUserEmailBody(c);
  const target = await getUserByEmail(email);
  if (!target) {
    return c.json({ detail: `User with email ${email} does not exist` }, 400);
  }
  const newPassword = generateRandomPassword();
  const passwordHash = await hashPassword(newPassword);
  await query(
    `UPDATE onyx_user SET password_hash = $2, updated_at = now() WHERE id = $1`,
    [target.id, passwordHash],
  );
  return c.json({ user_id: target.id, new_password: newPassword });
}
manageUsersRoutes.post("/password/reset_password", requireAdmin, resetPasswordHandler);

// GET /tenants/users/pending — cloud-tenant "requested to join" queue
// (SWR_KEYS.pendingTenantUsers, fetched as InvitedUserSnapshot[] only when
// NEXT_PUBLIC_CLOUD_ENABLED is on). No tenant flow exists in this port: the
// queue is always empty.
manageUsersRoutes.get("/tenants/users/pending", requireAuth, (c) => {
  return c.json([]);
});
