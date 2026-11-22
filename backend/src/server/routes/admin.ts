/**
 * Owned by Task 2-d. Admin surface — port of server/manage (Standard's
 * "/manage" router) plus the operational status/task endpoints.
 *
 * Python sources consulted:
 *   - /home/z/onyx/backend/onyx/server/manage/administrative.py
 *     (APIRouter(prefix="/manage") — admin-only endpoints; this port mounts
 *      the connector/credential/cc-pair management surface here too, matching
 *      the Python router inclusion under /manage)
 *   - /home/z/onyx/backend/onyx/server/documents/index_monitoring.py
 *     (index attempt monitoring -> GET /tasks reports recent task_queue rows)
 *   - /home/z/onyx/backend/onyx/redis/redis_pool.py
 *     (health PING against the shared Redis client)
 *
 * Routes: GET /status (counts of users/documents/chunks/tasks, Redis ping,
 * queue depth), GET /tasks (recent task_queue rows). The connector management
 * router (connectorsRoutes) is merged at "/" so the full /manage surface is
 * reachable — index.ts mounts adminRoutes at /manage, mirroring FastAPI's
 * router inclusion.
 */
import { Hono, type Context } from "hono";
import { query } from "../../db/client.js";
import { getRedis } from "../../key_value_store/redis_compat.js";
import { ForbiddenError } from "../../utils/errors.js";
import { getLogger } from "../../utils/logger.js";
import { connectorsRoutes, requireUser } from "./connectors.js";

const logger = getLogger("server.routes.admin");

export const adminRoutes = new Hono();

/**
 * Merge the connector/credential/cc-pair routes under /manage
 * (port of the Python routers all carrying prefix="/manage").
 */
adminRoutes.route("/", connectorsRoutes);

async function requireAdmin(c: Context) {
  const user = await requireUser(c);
  if (user.role !== "admin") {
    throw new ForbiddenError("Admin access required");
  }
  return user;
}

interface CountRow {
  count: string;
}

async function countOf(sql: string, params: readonly unknown[] = []): Promise<number> {
  const res = await query<CountRow>(sql, params);
  return Number(res.rows[0]?.count ?? 0);
}

// GET /manage/admin/opensearch-health — port of server/manage/
// opensearch_health/api.py read_resource_health (ResourceHealth). The
// original reads a Redis-cached snapshot written by the periodic checker;
// this port reports a fresh, issue-free snapshot (the embedded single-node
// OpenSearch has no heap/disk pressure reporting wired yet).
adminRoutes.get("/admin/opensearch-health", async (c) => {
  await requireAdmin(c);
  return c.json({
    checked_at: new Date().toISOString(),
    issues: [],
    stale: false,
  });
});

// POST /manage/admin/opensearch-health/popup — port of claim_resource_popup
// (ResourcePopupResponse): no issues -> never show the popup.
adminRoutes.post("/admin/opensearch-health/popup", async (c) => {
  await requireAdmin(c);
  return c.json({
    show_popup: false,
    health: {
      checked_at: new Date().toISOString(),
      issues: [],
      stale: false,
    },
  });
});

adminRoutes.get("/status", async (c) => {
  await requireAdmin(c);

  const [users, documents, chunks, tasks] = await Promise.all([
    countOf(`SELECT count(*) AS count FROM onyx_user`),
    countOf(`SELECT count(*) AS count FROM document`),
    countOf(`SELECT count(*) AS count FROM chunk`),
    countOf(`SELECT count(*) AS count FROM task_queue`),
  ]);

  const queueRes = await query<{ status: string; count: string }>(
    `SELECT status, count(*) AS count FROM task_queue GROUP BY status`,
  );
  const queueDepth: Record<string, number> = { queued: 0, running: 0, complete: 0, failed: 0 };
  for (const row of queueRes.rows) {
    queueDepth[row.status] = Number(row.count);
  }

  let redis: "up" | "down" = "down";
  try {
    const pong = await getRedis().ping();
    redis = pong === "PONG" ? "up" : "down";
  } catch (err) {
    logger.warning("redis ping failed", { error: String(err) });
  }

  return c.json({
    status: "ok",
    counts: {
      users,
      documents,
      chunks,
      tasks,
    },
    queue_depth: queueDepth,
    redis,
  });
});

adminRoutes.get("/tasks", async (c) => {
  await requireAdmin(c);
  const limitRaw = Number(c.req.query("limit") ?? "50");
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? limitRaw : 50;
  const res = await query<{
    id: number;
    type: string;
    args: unknown;
    status: string;
    priority: number;
    attempts: number;
    error: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, type, args, status, priority, attempts, error, created_at, updated_at
     FROM task_queue
     ORDER BY id DESC
     LIMIT $1`,
    [limit],
  );
  return c.json({
    tasks: res.rows.map((row) => ({
      id: row.id,
      type: row.type,
      args: row.args ?? {},
      status: row.status,
      priority: row.priority,
      attempts: row.attempts,
      error: row.error,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
  });
});
