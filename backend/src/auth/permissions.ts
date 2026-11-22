/**
 * Permission resolution — TypeScript port of backend/onyx/auth/permissions.py
 * and the Permission enum (backend/onyx/db/enums.py:704).
 *
 * Granted permissions are stored as a JSONB column on the User table
 * (effective_permissions, materialized from group membership by
 * recompute_user_permissions__no_commit). Implied permissions are expanded at
 * read time — only directly granted permissions are persisted.
 */
import type { User } from "../types/domain.js";

/** Port of db/enums.py Permission (str, Enum) values. */
export const Permission = {
  BASIC_ACCESS: "basic",
  READ_CONNECTORS: "read:connectors",
  READ_DOCUMENT_SETS: "read:document_sets",
  READ_AGENTS: "read:agents",
  READ_USERS: "read:users",
  READ_USER_GROUPS: "read:user_groups",
  READ_SEARCH: "read:search",
  READ_CHAT: "read:chat",
  WRITE_CHAT: "write:chat",
  READ_ADMIN: "read:admin",
  GENERATE_IMAGE: "generate:image",
  USE_LLM_GATEWAY: "use:llm_gateway",
  ADD_AGENTS: "add:agents",
  MANAGE_AGENTS: "manage:agents",
  MANAGE_DOCUMENT_SETS: "manage:document_sets",
  MANAGE_CONNECTORS: "manage:connectors",
  MANAGE_LLMS: "manage:llms",
  READ_AGENT_ANALYTICS: "read:agent_analytics",
  MANAGE_ACTIONS: "manage:actions",
  MANAGE_SKILLS: "manage:skills",
  READ_QUERY_HISTORY: "read:query_history",
  MANAGE_USER_GROUPS: "manage:user_groups",
  CREATE_USER_API_KEYS: "create:user_api_keys",
  MANAGE_SERVICE_ACCOUNT_API_KEYS: "manage:service_account_api_keys",
  MANAGE_BOTS: "manage:bots",
  CRAFT_SANDBOX: "craft_sandbox",
  FULL_ADMIN_PANEL_ACCESS: "admin",
} as const;

export type PermissionValue = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS: readonly string[] = Object.values(Permission);

/**
 * Implication map — port of auth/permissions.py IMPLIED_PERMISSIONS
 * (granted permission -> set of permissions it implies).
 */
export const IMPLIED_PERMISSIONS: Record<string, string[]> = {
  [Permission.MANAGE_AGENTS]: [
    Permission.ADD_AGENTS,
    Permission.READ_AGENTS,
    Permission.READ_DOCUMENT_SETS,
    Permission.READ_AGENT_ANALYTICS,
  ],
  [Permission.MANAGE_DOCUMENT_SETS]: [
    Permission.READ_DOCUMENT_SETS,
    Permission.READ_CONNECTORS,
    Permission.READ_USER_GROUPS,
  ],
  [Permission.MANAGE_CONNECTORS]: [
    Permission.READ_CONNECTORS,
    Permission.READ_USER_GROUPS,
  ],
  [Permission.MANAGE_USER_GROUPS]: [
    Permission.READ_CONNECTORS,
    Permission.READ_DOCUMENT_SETS,
    Permission.READ_AGENTS,
    Permission.READ_USERS,
    Permission.READ_USER_GROUPS,
  ],
  [Permission.MANAGE_LLMS]: [
    Permission.READ_USER_GROUPS,
    Permission.READ_AGENTS,
    Permission.READ_USERS,
  ],
  [Permission.MANAGE_SERVICE_ACCOUNT_API_KEYS]: [Permission.READ_USER_GROUPS],
  [Permission.MANAGE_ACTIONS]: [Permission.READ_USER_GROUPS],
  [Permission.BASIC_ACCESS]: [
    Permission.READ_SEARCH,
    Permission.READ_CHAT,
    Permission.WRITE_CHAT,
    Permission.GENERATE_IMAGE,
    Permission.USE_LLM_GATEWAY,
  ],
  [Permission.WRITE_CHAT]: [Permission.READ_CHAT],
  [Permission.CRAFT_SANDBOX]: [
    Permission.READ_SEARCH,
    Permission.GENERATE_IMAGE,
    Permission.USE_LLM_GATEWAY,
  ],
};

/** Port of CE_UNGATED_PERMISSIONS: auto-granted to all CE users (chat-only for anonymous). */
export const CE_UNGATED_PERMISSIONS: readonly string[] = [
  Permission.ADD_AGENTS,
];

/**
 * Port of resolve_effective_permissions + get_effective_permissions
 * (auth/permissions.py:292): read granted permissions, expand implications.
 * FULL_ADMIN_PANEL_ACCESS short-circuits to the full set.
 */
export function getEffectivePermissions(user: {
  effective_permissions?: string[] | null;
  is_anonymous_user?: boolean | null;
}): Set<string> {
  const granted = new Set<string>(user.effective_permissions ?? []);
  if (granted.has(Permission.FULL_ADMIN_PANEL_ACCESS)) {
    return new Set(ALL_PERMISSIONS);
  }
  // CE auto-grants capabilities, but never to the anonymous user.
  if (!user.is_anonymous_user) {
    for (const p of CE_UNGATED_PERMISSIONS) granted.add(p);
  }
  // Expand implications transitively.
  let grew = true;
  while (grew) {
    grew = false;
    for (const [granted0, implied] of Object.entries(IMPLIED_PERMISSIONS)) {
      if (!granted.has(granted0)) continue;
      for (const p of implied) {
        if (!granted.has(p)) {
          granted.add(p);
          grew = true;
        }
      }
    }
  }
  return granted;
}

/**
 * Port of _admin_capabilities (server/manage/models.py:157): admin-area reach =
 * effective tokens plus the scoped manager bundle when the user manages any group.
 */
export function adminCapabilities(
  effectivePermissions: Iterable<string>,
  isGroupManager: boolean,
): string[] {
  const caps = new Set<string>(effectivePermissions);
  if (isGroupManager) {
    // Port of SCOPED_MANAGER_PERMISSIONS_EXPANDED: the manager bundle plus its
    // implications.
    const bundle = [
      Permission.MANAGE_CONNECTORS,
      Permission.MANAGE_DOCUMENT_SETS,
      Permission.MANAGE_AGENTS,
      Permission.ADD_AGENTS,
      Permission.MANAGE_USER_GROUPS,
      Permission.MANAGE_ACTIONS,
      Permission.MANAGE_SKILLS,
    ];
    for (const p of bundle) {
      caps.add(p);
      for (const implied of IMPLIED_PERMISSIONS[p] ?? []) caps.add(implied);
    }
  }
  return [...caps].sort();
}

/** Port of db/users.py user_is_admin: admin = holds FULL_ADMIN_PANEL_ACCESS. */
export function userIsAdmin(user: User): boolean {
  return (user.effective_permissions ?? []).includes(
    Permission.FULL_ADMIN_PANEL_ACCESS,
  );
}
