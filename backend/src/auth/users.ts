/**
 * User data access + bootstrap — TypeScript port of:
 *   - /home/z/onyx/backend/onyx/db/users.py
 *       get_user_by_email (case-insensitive lower(email) match), fetch_user_by_id,
 *       get_all_users, delete/delete-user plumbing (not needed in this subset)
 *   - /home/z/onyx/backend/onyx/auth/users.py
 *       UserManager register flow (hash password, reject duplicate email) and
 *       user_manager.create; the User.validate_email lowercasing from db/models.py
 *   - /home/z/onyx/backend/onyx/db/auth.py
 *       get_active_admin_users semantics used for the default-admin check
 *
 * ensureDefaultAdmin bootstraps the admin account from DEFAULT_ADMIN_EMAIL /
 * DEFAULT_ADMIN_PASSWORD (configs/constants.ts) when no active admin exists.
 */
import { query, queryOne } from "../db/client.js";
import { rowToUser } from "../db/models/rows.js";
import { DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD } from "../configs/constants.js";
import { getLogger } from "../utils/logger.js";
import { InvalidRequestError, NotFoundError } from "../utils/errors.js";
import type { User } from "../types/domain.js";
import { hashPassword } from "./password.js";

const logger = getLogger("auth.users");

function normalizeEmail(email: string): string {
  // Port of User.validate_email (db/models.py): emails are stored lowercased.
  return email.trim().toLowerCase();
}

export interface CreateUserOptions {
  role?: User["role"];
  isActive?: boolean;
}

/** Port of the fastapi-users register path: dedupe email, bcrypt the password. */
export async function createUser(email: string, password: string, opts: CreateUserOptions = {}): Promise<User> {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new InvalidRequestError("Email is required");
  }

  const existing = await getUserByEmail(normalizedEmail);
  if (existing) {
    // fastapi-users raises UserAlreadyExists -> 400 REGISTER_USER_ALREADY_EXISTS
    throw new InvalidRequestError("A user with this email already exists");
  }

  const passwordHash = await hashPassword(password);
  // Deployment policy (all accounts are admin): the default role is "admin"
  // instead of the original's register-time `is_admin = user_count == 0`
  // heuristic; explicit opts.role callers keep working unchanged.
  const role = opts.role ?? "admin";
  const isActive = opts.isActive ?? true;

  try {
    const row = await queryOne<Record<string, unknown>>(
      `INSERT INTO onyx_user (email, password_hash, role, is_active)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [normalizedEmail, passwordHash, role, isActive],
    );
    if (!row) {
      throw new InvalidRequestError("Failed to create user");
    }
    const user = rowToUser(row);
    // Port of on_after_register -> assign_user_to_default_groups__no_commit
    // (db/users.py:835): place the user in the Admin default group (isAdmin is
    // forced for every account under this deployment's all-admin policy), then
    // materialize effective_permissions (recompute_user_permissions__no_commit).
    await assignUserToDefaultGroups(user.id, true);
    logger.info("created user", { email: normalizedEmail, role });
    return (await getUserById(user.id)) ?? user;
  } catch (err) {
    // unique_violation (23505) on concurrent register — same 400 as the pre-check
    if (typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "23505") {
      throw new InvalidRequestError("A user with this email already exists");
    }
    throw err;
  }
}

/** Port of db/users.py get_user_count (live users). */
export async function getUserCount(): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM onyx_user`,
  );
  return Number(row?.count ?? 0);
}

/**
 * Port of db/users.py assign_user_to_default_groups__no_commit + the
 * recompute_user_permissions__no_commit materialization: insert default-group
 * membership (Admin when is_admin, else Basic) and refresh the user's
 * effective_permissions column from group grants.
 */
export async function assignUserToDefaultGroups(
  userId: string,
  isAdmin: boolean,
): Promise<void> {
  const target = isAdmin ? "Admin" : "Basic";
  await query(
    `INSERT INTO user__user_group (user_id, user_group_id)
     SELECT $1, g.id FROM user_group g
     WHERE g.name = $2 AND g.is_default
     ON CONFLICT (user_id, user_group_id) DO NOTHING`,
    [userId, target],
  );
  await recomputeUserPermissions(userId);
}

/** Port of db/permissions.py recompute_user_permissions__no_commit. */
export async function recomputeUserPermissions(userId: string): Promise<void> {
  await query(
    `UPDATE onyx_user u SET effective_permissions = COALESCE(agg.perms, '[]'::jsonb)
     FROM (
       SELECT m.user_id, jsonb_agg(DISTINCT pg.permission) AS perms
       FROM user__user_group m
       JOIN permission_grant pg
         ON pg.group_id = m.user_group_id AND pg.is_deleted = false
       WHERE m.user_id = $1
       GROUP BY m.user_id
     ) agg WHERE u.id = agg.user_id`,
    [userId],
  );
  // Users in no grant-bearing group keep an empty (NOT NULL) column.
  await query(
    `UPDATE onyx_user SET effective_permissions = '[]'::jsonb
     WHERE id = $1 AND effective_permissions IS NULL`,
    [userId],
  );
}

/** Port of db/users.py get_user_by_email: case-insensitive email lookup. */
export async function getUserByEmail(email: string): Promise<User | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM onyx_user WHERE lower(email) = lower($1) LIMIT 1`,
    [normalizeEmail(email)],
  );
  return row ? rowToUser(row) : null;
}

/** Port of db/users.py fetch_user_by_id. */
export async function getUserById(userId: string): Promise<User | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM onyx_user WHERE id = $1 LIMIT 1`,
    [userId],
  );
  return row ? rowToUser(row) : null;
}

/** Port of db/users.py get_all_users (ordered oldest first, as the admin surface expects). */
export async function listUsers(): Promise<User[]> {
  const res = await query<Record<string, unknown>>(
    `SELECT * FROM onyx_user ORDER BY created_at ASC, id ASC`,
  );
  return res.rows.map(rowToUser);
}

/** Role management (admin surface). Throws NotFoundError when the user is gone. */
export async function updateUserRole(userId: string, role: User["role"]): Promise<User> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE onyx_user SET role = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [userId, role],
  );
  if (!row) {
    throw new NotFoundError("User");
  }
  logger.info("updated user role", { user_id: userId, role });
  return rowToUser(row);
}

/**
 * Port of the "first admin" bootstrap: if no active admin exists
 * (db/auth.py get_active_admin_users), create/promote the DEFAULT_ADMIN_* user.
 * Idempotent and safe to call concurrently (last writer wins with same values).
 */
export async function ensureDefaultAdmin(): Promise<void> {
  const activeAdmin = await queryOne<{ id: string }>(
    `SELECT id FROM onyx_user WHERE role = 'admin' AND is_active = true LIMIT 1`,
  );
  if (activeAdmin) {
    logger.debug("admin user already exists; skipping default admin bootstrap");
    return;
  }

  const email = normalizeEmail(DEFAULT_ADMIN_EMAIL);
  const existing = await getUserByEmail(email);
  if (existing) {
    if (existing.role !== "admin") {
      await updateUserRole(existing.id, "admin");
      logger.info("promoted default admin user", { email });
    }
    return;
  }

  await createUser(email, DEFAULT_ADMIN_PASSWORD, { role: "admin" });
  logger.info("seeded default admin user", { email });
}
