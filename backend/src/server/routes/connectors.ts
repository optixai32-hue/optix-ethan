/**
 * Owned by Task 2-d. Port of the connector/credential/cc-pair management API —
 * the server/manage surface of Standard.
 *
 * Python sources consulted:
 *   - /home/z/onyx/backend/onyx/server/documents/connector.py
 *     (router prefix "/manage": POST/PUT/GET /admin/connector, file upload for
 *      file connectors, admin-only via MANAGE_CONNECTORS permission)
 *   - /home/z/onyx/backend/onyx/server/documents/credential.py
 *     (router prefix "/manage": GET/POST /admin/credential, CredentialSnapshot)
 *   - /home/z/onyx/backend/onyx/server/documents/cc_pair.py
 *     (router prefix "/manage": GET /admin/cc-pair/{id}/index-attempts + runs;
 *      syncing a pair dispatches the docfetching task)
 *   - /home/z/onyx/backend/onyx/server/manage/administrative.py
 *     (the /manage admin router)
 *
 * Route shapes (spec): POST/GET /connector, POST/GET /credential,
 * POST/GET /cc-pair, POST /cc-pair/:id/sync (queues the connector_sync task —
 * the docfetching dispatch), GET /cc-pair/:id/status (latest IndexAttempt +
 * latest queue row). Mounted under /manage by server/routes/admin.ts (matching
 * the Python "/manage" prefix); requests are zod-validated and admin-gated.
 *
 * Auth note: task 2-a owns auth/middleware. Until it exists, a local minimal
 * check reads the session cookie (SESSION_COOKIE_NAME) and validates the
 * user_session row against the "user" table (port of FastAPI session auth).
 */
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { query, queryOne } from "../../db/client";
import { getSessionUser } from "../../auth/sessions";
import { SESSION_COOKIE_NAME, VALID_SOURCE_TYPES } from "../../configs/constants";
import { ForbiddenError, InvalidRequestError, NotFoundError, UnauthorizedError } from "../../utils/errors";
import { getLogger } from "../../utils/logger";
import { enqueueTask, TaskPriority } from "../../background/tasks";
import { CONNECTOR_FACTORIES } from "../../connectors/factory";
import type { User } from "../../types/domain";

const logger = getLogger("server.routes.connectors");

// ---------------------------------------------------------------------------
// Local minimal auth (temporary until task 2-a lands auth/middleware.js).
// Port of the FastAPI session-cookie auth dependency.
// ---------------------------------------------------------------------------

export async function requireUser(c: Context): Promise<User> {
  const sessionId = getCookie(c, SESSION_COOKIE_NAME);
  if (!sessionId) {
    throw new UnauthorizedError("Missing session cookie");
  }
  // Delegate to the auth subsystem (auth/sessions.ts) so the user lookup
  // stays consistent with the rest of the server (onyx_user table).
  const user = await getSessionUser(sessionId);
  if (!user) {
    throw new UnauthorizedError("Invalid or expired session");
  }
  return user;
}

/** Port of the MANAGE_CONNECTORS permission (admin/curator manage connectors). */
export async function requireConnectorManager(c: Context): Promise<User> {
  const user = await requireUser(c);
  if (user.role !== "admin" && user.role !== "curator" && user.role !== "global_curator") {
    throw new ForbiddenError("MANAGE_CONNECTORS permission required");
  }
  return user;
}

// ---------------------------------------------------------------------------
// Zod request schemas
// ---------------------------------------------------------------------------

const connectorCreateSchema = z.object({
  name: z.string().min(1),
  source: z.enum(VALID_SOURCE_TYPES),
  connector_specific_config: z.record(z.string(), z.unknown()).default({}),
});

const credentialCreateSchema = z.object({
  name: z.string().min(1),
  credential_json: z.record(z.string(), z.unknown()),
});

const ccPairCreateSchema = z.object({
  connector_id: z.number().int().positive(),
  credential_id: z.number().int().positive(),
  name: z.string().min(1),
});

type ConnectorRow = {
  id: number;
  name: string;
  source: string;
  connector_specific_config: Record<string, unknown> | null;
  created_at: Date;
};

type CredentialRow = {
  id: number;
  name: string;
  credential_json: Record<string, unknown> | null;
  created_at: Date;
};

type CcPairRow = {
  id: number;
  connector_id: number;
  credential_id: number;
  name: string;
  source: string;
  created_at: Date;
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const connectorsRoutes = new Hono();

function parseBody<T>(result: { success: boolean; data?: T; error?: z.ZodError }): T {
  if (!result.success) {
    const issues = (result.error?.issues ?? [])
      .map((i) => `${i.path.map(String).join(".")}: ${i.message}`)
      .join("; ");
    throw new InvalidRequestError(`invalid request body: ${issues}`);
  }
  return result.data as T;
}

// ---- Connector (port of server/documents/connector.py) ----

connectorsRoutes.post("/connector", async (c) => {
  await requireConnectorManager(c);
  const body = parseBody(connectorCreateSchema.safeParse(await c.req.json()));
  const row = await queryOne<ConnectorRow>(
    `INSERT INTO connector (name, source, connector_specific_config)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id, name, source, connector_specific_config, created_at`,
    [body.name, body.source, JSON.stringify(body.connector_specific_config ?? {})],
  );
  if (!row) throw new Error("connector insert returned no row");
  if (!CONNECTOR_FACTORIES[body.source]) {
    logger.warning("connector created for a source with no ported connector implementation", {
      connectorId: row.id,
      source: body.source,
    });
  }
  return c.json({ id: row.id, name: row.name, source: row.source }, 201);
});

connectorsRoutes.get("/connector", async (c) => {
  await requireConnectorManager(c);
  const res = await query<ConnectorRow>(
    `SELECT id, name, source, connector_specific_config, created_at
     FROM connector ORDER BY id`,
  );
  return c.json({
    connectors: res.rows.map((row) => ({
      id: row.id,
      name: row.name,
      source: row.source,
      connector_specific_config: row.connector_specific_config ?? {},
      created_at: row.created_at,
    })),
  });
});

// ---- Credential (port of server/documents/credential.py) ----

connectorsRoutes.post("/credential", async (c) => {
  await requireConnectorManager(c);
  const body = parseBody(credentialCreateSchema.safeParse(await c.req.json()));
  const row = await queryOne<CredentialRow>(
    `INSERT INTO credential (name, credential_json)
     VALUES ($1, $2::jsonb)
     RETURNING id, name, credential_json, created_at`,
    [body.name, JSON.stringify(body.credential_json)],
  );
  if (!row) throw new Error("credential insert returned no row");
  return c.json({ id: row.id, name: row.name }, 201);
});

connectorsRoutes.get("/credential", async (c) => {
  await requireConnectorManager(c);
  const res = await query<CredentialRow>(
    `SELECT id, name, credential_json, created_at FROM credential ORDER BY id`,
  );
  return c.json({
    credentials: res.rows.map((row) => ({
      id: row.id,
      name: row.name,
      credential_json: row.credential_json ?? {},
      created_at: row.created_at,
    })),
  });
});

// ---- CC pair (port of server/documents/cc_pair.py) ----

connectorsRoutes.post("/cc-pair", async (c) => {
  await requireConnectorManager(c);
  const body = parseBody(ccPairCreateSchema.safeParse(await c.req.json()));
  const connector = await queryOne<{ id: number }>(
    `SELECT id FROM connector WHERE id = $1`,
    [body.connector_id],
  );
  if (!connector) throw new NotFoundError("Connector");
  const credential = await queryOne<{ id: number }>(
    `SELECT id FROM credential WHERE id = $1`,
    [body.credential_id],
  );
  if (!credential) throw new NotFoundError("Credential");
  const row = await queryOne<CcPairRow>(
    `INSERT INTO connector_credential_pair (connector_id, credential_id, name)
     VALUES ($1, $2, $3)
     RETURNING id, connector_id, credential_id, name, created_at`,
    [body.connector_id, body.credential_id, body.name],
  );
  if (!row) throw new Error("cc pair insert returned no row");
  return c.json({ id: row.id, name: row.name }, 201);
});

connectorsRoutes.get("/cc-pair", async (c) => {
  await requireConnectorManager(c);
  const res = await query<CcPairRow>(
    `SELECT cp.id, cp.connector_id, cp.credential_id, cp.name, c.source, cp.created_at
     FROM connector_credential_pair cp
     JOIN connector c ON c.id = cp.connector_id
     ORDER BY cp.id`,
  );
  return c.json({
    cc_pairs: res.rows.map((row) => ({
      id: row.id,
      connector_id: row.connector_id,
      credential_id: row.credential_id,
      name: row.name,
      source: row.source,
      created_at: row.created_at,
    })),
  });
});

/**
 * Trigger a sync for one pair — port of the docfetching task dispatch
 * (task_creation_utils.apply_async on the docfetching queue).
 */
connectorsRoutes.post("/cc-pair/:id/sync", async (c) => {
  await requireConnectorManager(c);
  const ccPairId = Number(c.req.param("id"));
  if (!Number.isInteger(ccPairId) || ccPairId <= 0) {
    throw new InvalidRequestError("cc-pair id must be a positive integer");
  }
  const pair = await queryOne<{ id: number }>(
    `SELECT id FROM connector_credential_pair WHERE id = $1`,
    [ccPairId],
  );
  if (!pair) throw new NotFoundError("CC pair");
  const taskId = await enqueueTask("connector_sync", { ccPairId }, TaskPriority.MEDIUM);
  return c.json({ task_id: taskId, cc_pair_id: ccPairId }, 200);
});

/** Latest index attempt + queue status for the pair (index-monitoring subset). */
connectorsRoutes.get("/cc-pair/:id/status", async (c) => {
  await requireUser(c);
  const ccPairId = Number(c.req.param("id"));
  if (!Number.isInteger(ccPairId) || ccPairId <= 0) {
    throw new InvalidRequestError("cc-pair id must be a positive integer");
  }
  const pair = await queryOne<{ id: number; name: string; source: string }>(
    `SELECT cp.id, cp.name, c.source
     FROM connector_credential_pair cp
     JOIN connector c ON c.id = cp.connector_id
     WHERE cp.id = $1`,
    [ccPairId],
  );
  if (!pair) throw new NotFoundError("CC pair");
  const attempt = await queryOne<{
    id: number;
    status: string;
    total_docs: number;
    num_success: number;
    num_failed: number;
    error_msg: string | null;
    time_created: Date;
    time_updated: Date;
  }>(
    `SELECT id, status, total_docs, num_success, num_failed, error_msg, time_created, time_updated
     FROM index_attempt WHERE cc_pair_id = $1
     ORDER BY id DESC LIMIT 1`,
    [ccPairId],
  );
  const task = await queryOne<{
    id: number;
    status: string;
    attempts: number;
    error: string | null;
    updated_at: Date;
  }>(
    `SELECT id, status, attempts, error, updated_at
     FROM task_queue
     WHERE type = 'connector_sync' AND args->>'ccPairId' = $1
     ORDER BY id DESC LIMIT 1`,
    [String(ccPairId)],
  );
  return c.json({
    cc_pair: pair,
    latest_index_attempt: attempt ?? null,
    latest_task: task ?? null,
  });
});
