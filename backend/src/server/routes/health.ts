/**
 * Health routes — TypeScript port of:
 *   - /home/z/onyx/backend/onyx/server/manage/get_state.py
 *       GET /health (liveness probe: "Answers only 'is this process still running'")
 *   - /home/z/onyx/backend/onyx/server/manage/opensearch_health/api.py
 *       (backend datastore health check -> surfaced here as GET /health/db,
 *       probing the Postgres datasource)
 *
 * Standard mode only: the port always reports mode "standard" (real Postgres +
 * OpenSearch + redis stack; Lite-mode profiles are excluded from this port).
 */
import { Hono } from "hono";
import { query } from "../../db/client.js";
import { getLogger } from "../../utils/logger.js";

const logger = getLogger("routes.health");

export const healthRoutes = new Hono();

// GET /health — liveness (get_state.py healthcheck)
healthRoutes.get("/", (c) => {
  return c.json({
    status: "ok",
    mode: "standard",
    time: new Date().toISOString(),
  });
});

// GET /health/db — datasource probe (SELECT 1 against the Postgres pool)
healthRoutes.get("/db", async (c) => {
  try {
    await query("SELECT 1");
    return c.json({
      status: "ok",
      db: "ok",
      mode: "standard",
      time: new Date().toISOString(),
    });
  } catch (err) {
    logger.error("health/db probe failed", { error: String(err) });
    return c.json(
      {
        status: "error",
        db: "error",
        detail: String(err),
        time: new Date().toISOString(),
      },
      500,
    );
  }
});
