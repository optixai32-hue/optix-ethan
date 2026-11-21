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
 */
import { Hono } from "hono";
import { getAuth, requireAuth } from "../../auth/middleware";
import {
  adminCapabilities,
  getEffectivePermissions,
  Permission,
} from "../../auth/permissions";
import { query, queryOne } from "../../db/client";
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

// GET /user/assistant/preferences — port of server/manage/users.py
// get_user_assistant_preferences: dict<assistant_id,
// {disabled_tool_ids, disabled_integration_ids}>. Fresh deployment: {}.
manageUsersRoutes.get("/user/assistant/preferences", requireAuth, (c) => {
  return c.json({});
});

// ---------------------------------------------------------------------------
// EE: users admin listing (port of server/manage/users.py user management
// read surface). The web frontend hits:
//   - GET /manage/users?include_api_keys=true  -> AllUsersResponse
//     (web/src/lib/types.ts AllUsersResponse; rows follow FullUserSnapshot in
//      web/src/views/admin/UsersPage/types.ts — the group create/edit pages
//      build their member picker from this, including group managers who only
//      hold the scoped READ_USERS permission)
//   - GET /manage/users/counts                 -> status/account-type tallies
//     (web/src/hooks/useUserCounts.ts UserCountsResponse)
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

  const accepted = usersRes.rows.map((row) => {
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
