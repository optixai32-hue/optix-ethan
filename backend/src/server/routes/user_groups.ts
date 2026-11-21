/**
 * EE user-groups admin surface — Task 4. Port of
 * backend/onyx/server/manage/user_groups.py (APIRouter prefix "/manage") and
 * its permission-registry sidecar (backend/onyx/auth/permissions.py
 * PERMISSION_REGISTRY).
 *
 * Frontend contract (verified against /home/z/onyx/web/src):
 *   - GET  /manage/admin/user-group[?include_default=true]  -> UserGroup[]
 *     (web/src/lib/types.ts UserGroup: users[], manager_ids[], cc_pairs[],
 *      document_sets[], personas[], is_up_to_date, is_up_for_deletion,
 *      is_default, incognito_enabled, permissions map via
 *      web/src/lib/permissions/resource-actions.ts RESOURCE_ACTIONS.UserGroup)
 *   - POST /manage/admin/user-group                         -> created UserGroup
 *     (web/src/views/admin/GroupsPage/svc.ts createGroup: {name, user_ids,
 *      cc_pair_ids}; response read as UserGroup to take .id)
 *   - PATCH /manage/admin/user-group/rename                 -> {id, name}
 *   - GET/PATCH/DELETE /manage/admin/user-group/:id
 *     (updateGroup body {user_ids, cc_pair_ids}; DELETE forbidden on defaults)
 *   - PATCH /manage/admin/user-group/:id/incognito          -> {enabled}
 *   - PATCH /manage/admin/user-group/:id/agents             -> {added_agent_ids, removed_agent_ids}
 *   - PATCH /manage/admin/user-group/:id/document-sets      -> {added_document_set_ids, removed_document_set_ids}
 *   - PUT  /manage/admin/user-group/:id/manager             -> {user_id, is_manager}
 *   - GET/PUT /manage/admin/user-group/:id/permissions      -> string[] / {permissions: string[]}
 *     (EditGroupPage.tsx reads a string[]; svc.ts saveGroupPermissions PUTs the
 *      whole desired set in one request)
 *   - GET /manage/admin/permissions/registry                -> PermissionRegistryEntry[]
 *     (web/src/views/admin/GroupsPage/types.ts: {id, display_name, description,
 *      permissions, group, default_group_toggleable}; ICON_MAP ids in
 *      GroupPermissionsSection.tsx must match)
 *   - GET /manage/user-groups/minimal                       -> {id, name}[]
 *     (web/src/hooks/useShareableGroups.ts MinimalUserGroupSnapshot; user_ids
 *      included as a task-spec extra)
 *
 * Permission overrides persist in the permission_grant table (migration 0006
 * schema; is_deleted soft-delete + UNIQUE (group_id, permission)). After any
 * grant change the affected members' effective_permissions JSONB is
 * recomputed (port of recompute_user_permissions__no_commit).
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { getAuth, requireAuth } from "../../auth/middleware";
import { Permission, getEffectivePermissions } from "../../auth/permissions";
import { query, queryOne, withTransaction } from "../../db/client";
import {
  ForbiddenError,
  InvalidRequestError,
  NotFoundError,
} from "../../utils/errors";
import { getLogger } from "../../utils/logger";
import type { User } from "../../types/domain";

const logger = getLogger("server.routes.user_groups");

export const userGroupRoutes = new Hono();

// ---------------------------------------------------------------------------
// Auth helpers (match manage_users.ts pattern: middleware + explicit checks)
// ---------------------------------------------------------------------------

function requireAuthUser(c: Context): User | null {
  return getAuth(c)?.user ?? null;
}

/** Effective-permission check — admins hold FULL_ADMIN_PANEL_ACCESS. */
function userHasPermission(user: User, permission: string): boolean {
  if (user.role === "admin") return true;
  return getEffectivePermissions(user).has(permission);
}

/** The requester may administer this group: admin, manage:user_groups, or the group's manager. */
async function assertCanManageGroup(c: Context, groupId: number): Promise<User> {
  const user = requireAuthUser(c);
  if (!user) {
    // requireAuth guarantees an AuthContext; this is a defensive 403 only.
    throw new ForbiddenError("You do not have permission to perform this action");
  }
  if (userHasPermission(user, Permission.MANAGE_USER_GROUPS)) {
    return user;
  }
  const managerRow = await queryOne<{ is_manager: boolean }>(
    `SELECT is_manager FROM user__user_group
     WHERE user_id = $1 AND user_group_id = $2 AND is_manager`,
    [user.id, groupId],
  );
  if (managerRow) return user;
  throw new ForbiddenError("You do not have permission to perform this action");
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface UserGroupRow {
  id: number;
  name: string;
  is_up_to_date: boolean;
  is_up_for_deletion: boolean;
  is_default: boolean;
  incognito_enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

interface MemberRow {
  user_id: string;
  is_manager: boolean;
}

interface MemberUserRow {
  id: string;
  email: string;
  role: string;
  is_active: boolean;
  personal_name: string | null;
  personal_role: string | null;
  effective_permissions: string[] | null;
  is_group_manager: boolean;
}

/** UserGroup.permissions map — web/src/lib/permissions/resource-actions.ts RESOURCE_ACTIONS.UserGroup. */
async function groupPermissionsMap(
  user: User,
  group: UserGroupRow,
): Promise<Record<string, boolean>> {
  const isAdmin = user.role === "admin";
  const canManageAll = userHasPermission(user, Permission.MANAGE_USER_GROUPS);
  const managerRow = await queryOne<{ is_manager: boolean }>(
    `SELECT is_manager FROM user__user_group
     WHERE user_id = $1 AND user_group_id = $2 AND is_manager`,
    [user.id, group.id],
  );
  const isManager = Boolean(managerRow);
  // A default group has only members — no manage/delete/permission/token-limit
  // affordances (mirrors server-side stamping the GroupsPage comments expect;
  // manage_members still opens the card).
  return {
    manage: (isAdmin || canManageAll || isManager) && !group.is_default,
    manage_members: isAdmin || canManageAll || isManager,
    delete: (isAdmin || canManageAll) && !group.is_default && !group.is_up_for_deletion,
    edit_permissions: (isAdmin || canManageAll) && !group.is_default,
    edit_token_limits: isAdmin || canManageAll,
  };
}

/** Full UserGroup payload — every field the frontend UserGroup interface reads. */
async function buildUserGroupPayload(
  user: User,
  group: UserGroupRow,
): Promise<Record<string, unknown>> {
  const memberRes = await query<MemberRow>(
    `SELECT user_id, is_manager FROM user__user_group WHERE user_group_id = $1`,
    [group.id],
  );
  const memberIds = memberRes.rows.map((r) => r.user_id);
  const managerIds = memberRes.rows.filter((r) => r.is_manager).map((r) => r.user_id);

  // Member User objects — GroupCard counts u.is_active; EditGroupPage maps
  // u.id; manager assignment cross-checks emails/ids.
  const usersRes = memberIds.length
    ? await query<MemberUserRow>(
        `SELECT id, email, role, is_active, personal_name, personal_role,
                effective_permissions, is_group_manager
         FROM onyx_user
         WHERE id = ANY($1::uuid[])
         ORDER BY created_at ASC, id ASC`,
        [memberIds],
      )
    : { rows: [] as MemberUserRow[] };
  const users = usersRes.rows.map((u) => ({
    id: u.id,
    email: u.email,
    account_type: "STANDARD",
    is_admin: u.role === "admin",
    role: u.role,
    is_active: u.is_active,
    is_superuser: u.role === "admin",
    is_verified: true,
    personal_name: u.personal_name,
    personal_role: u.personal_role,
    effective_permissions: u.effective_permissions ?? [],
    is_group_manager: u.is_group_manager,
    is_scim_synced: false,
  }));

  return {
    id: group.id,
    name: group.name,
    user_ids: memberIds,
    users,
    manager_ids: managerIds,
    group_manager_ids: managerIds, // alias (task-spec naming)
    // No cc-pair / document-set / persona group-sharing tables in this port —
    // the edit page reads empty arrays and its share sections stay no-ops.
    cc_pairs: [],
    document_sets: [],
    personas: [],
    is_up_to_date: group.is_up_to_date,
    is_up_for_deletion: group.is_up_for_deletion,
    is_default: group.is_default,
    incognito_enabled: group.incognito_enabled,
    created_at: group.created_at.toISOString(),
    updated_at: group.updated_at.toISOString(),
    permissions: await groupPermissionsMap(user, group),
  };
}

async function fetchGroupRow(groupId: number): Promise<UserGroupRow> {
  const row = await queryOne<UserGroupRow>(
    `SELECT id, name, is_up_to_date, is_up_for_deletion, is_default,
            incognito_enabled, created_at, updated_at
     FROM user_group WHERE id = $1`,
    [groupId],
  );
  if (!row) throw new NotFoundError("User group");
  return row;
}

async function parseGroupId(raw: string): Promise<number> {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new NotFoundError("User group");
  }
  return id;
}

async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === "string");
}

/** Replace group membership with the given user_ids (user__user_group sync). */
async function syncGroupMembers(groupId: number, userIds: string[]): Promise<void> {
  // Members before + after the sync need their derived flags recomputed
  // (removed users lose group-derived grants and manager status).
  const before = await query<{ user_id: string }>(
    `SELECT user_id FROM user__user_group WHERE user_group_id = $1`,
    [groupId],
  );
  const affected = new Set<string>([
    ...before.rows.map((r) => r.user_id),
    ...userIds,
  ]);
  await withTransaction(async (client) => {
    await client.query(`DELETE FROM user__user_group WHERE user_group_id = $1`, [
      groupId,
    ]);
    for (const userId of userIds) {
      await client.query(
        `INSERT INTO user__user_group (user_id, user_group_id)
         VALUES ($1, $2)
         ON CONFLICT (user_id, user_group_id) DO NOTHING`,
        [userId, groupId],
      );
    }
  });
  for (const userId of affected) {
    await recomputeUserDerivedFlags(userId);
  }
}

/**
 * Recompute one user's derived flags (port of recompute_user_permissions__no_commit):
 * effective_permissions = union of grants across all their groups (implication
 * expansion happens at read time — see auth/permissions.ts), is_group_manager =
 * manages any group.
 */
async function recomputeUserDerivedFlags(userId: string): Promise<void> {
  await query(
    `UPDATE onyx_user u
     SET effective_permissions = COALESCE((
           SELECT jsonb_agg(DISTINCT pg.permission)
           FROM user__user_group m
           JOIN permission_grant pg
             ON pg.group_id = m.user_group_id AND pg.is_deleted = false
           WHERE m.user_id = u.id
         ), '[]'::jsonb),
         is_group_manager = EXISTS (
           SELECT 1 FROM user__user_group m
           WHERE m.user_id = u.id AND m.is_manager
         )
     WHERE u.id = $1`,
    [userId],
  );
}

/** Recompute effective_permissions for every current member of the group. */
async function recomputeGroupMemberPermissions(groupId: number): Promise<void> {
  await query(
    `UPDATE onyx_user u
     SET effective_permissions = COALESCE((
           SELECT jsonb_agg(DISTINCT pg.permission)
           FROM user__user_group m
           JOIN permission_grant pg
             ON pg.group_id = m.user_group_id AND pg.is_deleted = false
           WHERE m.user_id = u.id
         ), '[]'::jsonb)
     WHERE u.id IN (
       SELECT user_id FROM user__user_group WHERE user_group_id = $1
     )`,
    [groupId],
  );
}

// ---------------------------------------------------------------------------
// Permission registry (frontend PermissionRegistryEntry)
// ---------------------------------------------------------------------------

interface RegistryEntry {
  id: string;
  display_name: string;
  description: string;
  permissions: string[];
  group: number;
  default_group_toggleable: boolean;
}

// Entries mirror web/src/views/admin/GroupsPage/GroupPermissionsSection.tsx
// ICON_MAP ids (plus a skills row). `group` drives section dividers.
const PERMISSION_REGISTRY: RegistryEntry[] = [
  {
    id: "manage_llms",
    display_name: "Manage LLMs",
    description: "Configure LLM providers, models and default settings.",
    permissions: [Permission.MANAGE_LLMS],
    group: 1,
    default_group_toggleable: true,
  },
  {
    id: "manage_connectors",
    display_name: "Manage Connectors",
    description: "Create and operate indexing connectors and credentials.",
    permissions: [Permission.MANAGE_CONNECTORS],
    group: 1,
    default_group_toggleable: false,
  },
  {
    id: "manage_document_sets",
    display_name: "Manage Document Sets",
    description: "Create document sets and manage their access.",
    permissions: [Permission.MANAGE_DOCUMENT_SETS],
    group: 1,
    default_group_toggleable: false,
  },
  {
    id: "manage_actions",
    display_name: "Manage Actions",
    description: "Configure tools and actions available to assistants.",
    permissions: [Permission.MANAGE_ACTIONS],
    group: 1,
    default_group_toggleable: false,
  },
  {
    id: "manage_groups",
    display_name: "Manage User Groups",
    description: "Create user groups and manage their members and permissions.",
    permissions: [Permission.MANAGE_USER_GROUPS],
    group: 1,
    default_group_toggleable: false,
  },
  {
    id: "manage_service_accounts",
    display_name: "Manage Service Accounts",
    description: "Create and manage service-account API keys.",
    permissions: [Permission.MANAGE_SERVICE_ACCOUNT_API_KEYS],
    group: 1,
    default_group_toggleable: false,
  },
  {
    id: "manage_bots",
    display_name: "Manage Bots",
    description: "Configure Slack bots and channel settings.",
    permissions: [Permission.MANAGE_BOTS],
    group: 1,
    default_group_toggleable: false,
  },
  {
    id: "create_agents",
    display_name: "Create Assistants",
    description: "Create personal assistants.",
    permissions: [Permission.ADD_AGENTS],
    group: 2,
    default_group_toggleable: true,
  },
  {
    id: "manage_agents",
    display_name: "Manage Assistants",
    description: "Edit, publish and delete shared assistants.",
    permissions: [Permission.MANAGE_AGENTS],
    group: 2,
    default_group_toggleable: false,
  },
  {
    id: "view_agent_analytics",
    display_name: "View Assistant Analytics",
    description: "See usage analytics for shared assistants.",
    permissions: [Permission.READ_AGENT_ANALYTICS],
    group: 2,
    default_group_toggleable: true,
  },
  {
    id: "view_query_history",
    display_name: "View Query History",
    description: "Read the admin query-history and chat logs.",
    permissions: [Permission.READ_QUERY_HISTORY],
    group: 2,
    default_group_toggleable: false,
  },
  {
    id: "manage_skills",
    display_name: "Manage Skills",
    description: "Create and manage custom skills.",
    permissions: [Permission.MANAGE_SKILLS],
    group: 2,
    default_group_toggleable: false,
  },
  {
    id: "create_user_access_token",
    display_name: "Create Personal API Keys",
    description: "Create personal API keys for API access.",
    permissions: [Permission.CREATE_USER_API_KEYS],
    group: 3,
    default_group_toggleable: true,
  },
];

// ---------------------------------------------------------------------------
// Routes (mounted at /manage — see src/index.ts)
// ---------------------------------------------------------------------------

// GET /manage/admin/user-group?include_default=true — UserGroup[] listing.
userGroupRoutes.get("/admin/user-group", requireAuth, async (c) => {
  const user = requireAuthUser(c);
  if (!user) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  if (!userHasPermission(user, Permission.READ_USER_GROUPS)) {
    return c.json(
      { detail: "You do not have permission to perform this action" },
      403,
    );
  }
  const includeDefault = c.req.query("include_default") === "true";
  const groupsRes = await query<UserGroupRow>(
    `SELECT id, name, is_up_to_date, is_up_for_deletion, is_default,
            incognito_enabled, created_at, updated_at
     FROM user_group
     ${includeDefault ? "" : "WHERE is_default = false"}
     ORDER BY id ASC`,
  );
  const groups = await Promise.all(
    groupsRes.rows.map((row) => buildUserGroupPayload(user, row)),
  );
  return c.json(groups);
});

// POST /manage/admin/user-group — create (svc.ts createGroup body:
// { name, user_ids, cc_pair_ids }). Returns the created UserGroup (201).
userGroupRoutes.post("/admin/user-group", requireAuth, async (c) => {
  const user = requireAuthUser(c);
  if (!user) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  if (!userHasPermission(user, Permission.MANAGE_USER_GROUPS)) {
    return c.json(
      { detail: "You do not have permission to perform this action" },
      403,
    );
  }
  const body = await readJsonBody(c);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    throw new InvalidRequestError("Group name is required");
  }
  const userIds = asStringArray(body.user_ids) ?? [];
  const created = await withTransaction(async (client) => {
    const inserted = await client.query<UserGroupRow>(
      `INSERT INTO user_group (name) VALUES ($1)
       RETURNING id, name, is_up_to_date, is_up_for_deletion, is_default,
                 incognito_enabled, created_at, updated_at`,
      [name],
    );
    const row = inserted.rows[0];
    for (const userId of userIds) {
      await client.query(
        `INSERT INTO user__user_group (user_id, user_group_id)
         VALUES ($1, $2)
         ON CONFLICT (user_id, user_group_id) DO NOTHING`,
        [userId, row.id],
      );
    }
    return row;
  });
  recomputeGroupMemberPermissions(created.id).catch((err) => {
    logger.warning("post-create permission recompute failed", {
      groupId: created.id,
      error: String(err),
    });
  });
  return c.json(await buildUserGroupPayload(user, created), 201);
});

// GET /manage/admin/user-group/:id — single group detail.
userGroupRoutes.get("/admin/user-group/:id", requireAuth, async (c) => {
  const user = requireAuthUser(c);
  if (!user) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  const groupId = await parseGroupId(c.req.param("id"));
  const group = await fetchGroupRow(groupId);
  return c.json(await buildUserGroupPayload(user, group));
});

// PATCH /manage/admin/user-group/rename — svc.ts renameGroup body {id, name}.
// Registered before the /:id wildcard so "rename" never parses as an id.
userGroupRoutes.patch("/admin/user-group/rename", requireAuth, async (c) => {
  const user = requireAuthUser(c);
  if (!user) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  const body = await readJsonBody(c);
  const groupId = Number(body.id);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!Number.isInteger(groupId) || groupId <= 0 || !name) {
    throw new InvalidRequestError("id and name are required");
  }
  await assertCanManageGroup(c, groupId);
  const updated = await queryOne<UserGroupRow>(
    `UPDATE user_group SET name = $2, updated_at = now() WHERE id = $1
     RETURNING id, name, is_up_to_date, is_up_for_deletion, is_default,
               incognito_enabled, created_at, updated_at`,
    [groupId, name],
  );
  if (!updated) throw new NotFoundError("User group");
  return c.json(null);
});

// PATCH /manage/admin/user-group/:id — membership update
// (svc.ts updateGroup body {user_ids, cc_pair_ids}).
userGroupRoutes.patch("/admin/user-group/:id", requireAuth, async (c) => {
  const groupId = await parseGroupId(c.req.param("id"));
  const user = await assertCanManageGroup(c, groupId);
  const body = await readJsonBody(c);
  const userIds = asStringArray(body.user_ids);
  if (userIds !== null) {
    await syncGroupMembers(groupId, userIds);
    await recomputeGroupMemberPermissions(groupId);
  }
  // cc_pair_ids accepted but ignored: no cc-pair group-sharing table here.
  const group = await fetchGroupRow(groupId);
  return c.json(await buildUserGroupPayload(user, group));
});

// DELETE /manage/admin/user-group/:id — forbidden on default groups (403) and
// on groups already marked up-for-deletion (409), mirroring the task contract.
userGroupRoutes.delete("/admin/user-group/:id", requireAuth, async (c) => {
  const groupId = await parseGroupId(c.req.param("id"));
  const user = requireAuthUser(c);
  if (!user) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  if (!userHasPermission(user, Permission.MANAGE_USER_GROUPS)) {
    return c.json(
      { detail: "You do not have permission to perform this action" },
      403,
    );
  }
  const group = await fetchGroupRow(groupId);
  if (group.is_default) {
    return c.json(
      { detail: "Default groups cannot be deleted" },
      403,
    );
  }
  if (group.is_up_for_deletion) {
    return c.json(
      { detail: "Group is already up for deletion" },
      409,
    );
  }
  // Capture members first: the cascade wipes user__user_group rows and the
  // users lose this group's grants + manager status.
  const members = await query<{ user_id: string }>(
    `SELECT user_id FROM user__user_group WHERE user_group_id = $1`,
    [groupId],
  );
  await query(`DELETE FROM user_group WHERE id = $1`, [groupId]);
  for (const row of members.rows) {
    await recomputeUserDerivedFlags(row.user_id);
  }
  return c.json(null);
});

// PATCH /manage/admin/user-group/:id/incognito — svc.ts setGroupIncognito.
userGroupRoutes.patch("/admin/user-group/:id/incognito", requireAuth, async (c) => {
  const groupId = await parseGroupId(c.req.param("id"));
  await assertCanManageGroup(c, groupId);
  const body = await readJsonBody(c);
  const enabled = body.enabled === true;
  await query(
    `UPDATE user_group SET incognito_enabled = $2, updated_at = now() WHERE id = $1`,
    [groupId, enabled],
  );
  return c.json(null);
});

// PATCH /manage/admin/user-group/:id/agents — persona sharing. No
// persona <-> group sharing table exists in this port, so the write is a
// validated no-op (the edit page treats these sections as empty).
userGroupRoutes.patch("/admin/user-group/:id/agents", requireAuth, async (c) => {
  const groupId = await parseGroupId(c.req.param("id"));
  await assertCanManageGroup(c, groupId);
  await readJsonBody(c);
  return c.json(null);
});

// PATCH /manage/admin/user-group/:id/document-sets — document-set sharing,
// also a validated no-op in this port.
userGroupRoutes.patch(
  "/admin/user-group/:id/document-sets",
  requireAuth,
  async (c) => {
    const groupId = await parseGroupId(c.req.param("id"));
    await assertCanManageGroup(c, groupId);
    await readJsonBody(c);
    return c.json(null);
  },
);

// PUT /manage/admin/user-group/:id/manager — svc.ts setGroupManager body
// {user_id, is_manager}. Requires the user to be a member.
userGroupRoutes.put("/admin/user-group/:id/manager", requireAuth, async (c) => {
  const groupId = await parseGroupId(c.req.param("id"));
  await assertCanManageGroup(c, groupId);
  const body = await readJsonBody(c);
  const userId = typeof body.user_id === "string" ? body.user_id : null;
  const isManager = body.is_manager === true;
  if (!userId) {
    throw new InvalidRequestError("user_id is required");
  }
  const member = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM user__user_group
     WHERE user_id = $1 AND user_group_id = $2`,
    [userId, groupId],
  );
  if (!member) {
    throw new InvalidRequestError("User is not a member of this group");
  }
  await query(
    `UPDATE user__user_group SET is_manager = $3
     WHERE user_id = $1 AND user_group_id = $2`,
    [userId, groupId, isManager],
  );
  await recomputeUserDerivedFlags(userId);
  return c.json(null);
});

// GET /manage/admin/user-group/:id/permissions — string[] of granted keys
// (EditGroupPage useSWR<string[]>).
userGroupRoutes.get(
  "/admin/user-group/:id/permissions",
  requireAuth,
  async (c) => {
    const groupId = await parseGroupId(c.req.param("id"));
    await fetchGroupRow(groupId);
    const user = requireAuthUser(c);
    if (!user) {
      return c.json({ detail: "Unauthorized" }, 401);
    }
    if (!userHasPermission(user, Permission.FULL_ADMIN_PANEL_ACCESS)) {
      return c.json(
        { detail: "You do not have permission to perform this action" },
        403,
      );
    }
    const grants = await query<{ permission: string }>(
      `SELECT permission FROM permission_grant
       WHERE group_id = $1 AND is_deleted = false
       ORDER BY permission ASC`,
      [groupId],
    );
    return c.json(grants.rows.map((r) => r.permission));
  },
);

// PUT /manage/admin/user-group/:id/permissions — svc.ts saveGroupPermissions
// body {permissions: string[]}: replace the desired grant set in one request,
// then recompute member effective_permissions.
userGroupRoutes.put(
  "/admin/user-group/:id/permissions",
  requireAuth,
  async (c) => {
    const groupId = await parseGroupId(c.req.param("id"));
    const user = requireAuthUser(c);
    if (!user) {
      return c.json({ detail: "Unauthorized" }, 401);
    }
    if (!userHasPermission(user, Permission.FULL_ADMIN_PANEL_ACCESS)) {
      return c.json(
        { detail: "You do not have permission to perform this action" },
        403,
      );
    }
    const group = await fetchGroupRow(groupId);
    if (group.is_default) {
      return c.json(
        { detail: "Default group permissions cannot be changed" },
        403,
      );
    }
    const body = await readJsonBody(c);
    const desired = asStringArray(body.permissions) ?? [];
    await withTransaction(async (client) => {
      const existing = await client.query<{ permission: string }>(
        `SELECT permission FROM permission_grant WHERE group_id = $1`,
        [groupId],
      );
      const existingSet = new Set(existing.rows.map((r) => r.permission));
      const desiredSet = new Set(desired);
      // Soft-delete grants the request dropped.
      for (const permission of existingSet) {
        if (desiredSet.has(permission)) continue;
        await client.query(
          `UPDATE permission_grant SET is_deleted = true, updated_at = now()
           WHERE group_id = $1 AND permission = $2`,
          [groupId, permission],
        );
      }
      // Insert or revive grants the request added.
      for (const permission of desiredSet) {
        await client.query(
          `INSERT INTO permission_grant (group_id, permission, grant_source, is_deleted)
           VALUES ($1, $2, 'MANUAL', false)
           ON CONFLICT (group_id, permission)
           DO UPDATE SET is_deleted = false, updated_at = now()`,
          [groupId, permission],
        );
      }
    });
    await recomputeGroupMemberPermissions(groupId);
    return c.json(null);
  },
);

// GET /manage/admin/permissions/registry — PermissionRegistryEntry[].
userGroupRoutes.get("/admin/permissions/registry", requireAuth, (c) => {
  return c.json(PERMISSION_REGISTRY);
});

// GET /manage/user-groups/minimal — MinimalUserGroupSnapshot[] for sharing
// pickers ({id, name}; user_ids included as a task-spec extra).
userGroupRoutes.get("/user-groups/minimal", requireAuth, async (c) => {
  const user = requireAuthUser(c);
  if (!user) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  if (!userHasPermission(user, Permission.READ_USER_GROUPS)) {
    return c.json(
      { detail: "You do not have permission to perform this action" },
      403,
    );
  }
  const res = await query<{ id: number; name: string; user_ids: string[] }>(
    `SELECT g.id, g.name,
            COALESCE(
              jsonb_agg(m.user_id ORDER BY m.user_id) FILTER (WHERE m.user_id IS NOT NULL),
              '[]'::jsonb
            ) AS user_ids
     FROM user_group g
     LEFT JOIN user__user_group m ON m.user_group_id = g.id
     GROUP BY g.id, g.name
     ORDER BY g.id ASC`,
  );
  return c.json(res.rows.map((r) => ({ id: r.id, name: r.name, user_ids: r.user_ids })));
});
