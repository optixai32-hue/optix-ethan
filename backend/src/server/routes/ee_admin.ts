/**
 * EE /admin surface — Task 4. Port of:
 *   - backend/onyx/server/ee/query_history.py   (GET /admin/chat-session-history
 *     + /admin/chat-session-history/{id}, the CSV export task endpoints)
 *   - backend/onyx/server/enterprise/settings.py (GET/POST
 *     /admin/enterprise-settings/scim/token)
 *   - backend/onyx/server/admin/log_export.py   (POST /admin/log-export,
 *     GET /admin/log-export/{id}, GET /admin/log-export/{id}/download)
 *
 * Frontend contract (verified against /home/z/onyx/web/src):
 *   - GET /admin/chat-session-history -> PaginatedApiResponse<ChatSessionMinimal>
 *     (web/src/hooks/usePaginatedFetch.ts: {items, total_items}; params
 *      page_num (0-based batch index), page_size, start_time, end_time,
 *      feedback_type). ChatSessionMinimal fields from
 *      web/src/app/ee/admin/performance/usage/types.ts.
 *   - GET /admin/chat-session-history/:id -> ChatSessionSnapshot (detail page).
 *   - POST /admin/query-history/start-export?start=&end= -> {request_id}
 *   - GET  /admin/query-history/export-status?request_id= -> {status}
 *   - GET  /admin/query-history/download?request_id= -> CSV
 *   - GET  /admin/query-history/list -> TaskQueueState[]
 *     (web/src/app/ee/admin/performance/query-history/{constants,types}.tsx)
 *   - GET /admin/enterprise-settings/scim/token -> ScimTokenResponse | null
 *     (web/src/views/admin/ScimPage/types.ts: {id, name, token_display,
 *      is_active, created_at, last_used_at, idp_domain}); POST (rotate /
 *      regenerate) -> ScimTokenCreatedResponse with raw_token. PUT accepted as
 *      a rotate alias (task spec).
 *   - POST /admin/log-export -> {export_id} (uuid4().hex, 32 hex chars —
 *     ExportLogsPage EXPORT_ID_PATTERN); GET /admin/log-export/:id ->
 *     LogExportStatus {export_id, state: "collecting"|"ready", receipts[],
 *     pending_worker_names[]}; GET /admin/log-export/:id/download -> bundle.
 *
 * The query-history CSV export and the log export complete immediately
 * (single-node deployment): exports are held in-process with a TTL instead of
 * task_queue rows.
 */
import { Hono, type Context } from "hono";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { getAuth, requireAdmin } from "../../auth/middleware";
import { query, queryOne } from "../../db/client";
import { NotFoundError } from "../../utils/errors";
import { getLogger } from "../../utils/logger";

const logger = getLogger("server.routes.ee_admin");

export const eeAdminRoutes = new Hono();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function csvEscape(value: string | number | null): string {
  const raw = value === null ? "" : String(value);
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

// ---------------------------------------------------------------------------
// Chat session history (query history page)
// ---------------------------------------------------------------------------

interface SessionHistoryRow {
  id: string;
  title: string;
  user_id: string | null;
  user_email: string | null;
  persona_id: number | null;
  persona_name: string | null;
  created_at: Date;
  message_count: string;
}

interface FirstMessageRow {
  chat_session_id: string;
  role: string;
  message: string;
}

interface SessionFilter {
  startTime: Date | null;
  endTime: Date | null;
  feedbackType: string | null;
}

function parseSessionFilter(c: Context): SessionFilter {
  // start_time/end_time (query-history page filters) and start/end
  // (task-spec) are both accepted.
  const startRaw = c.req.query("start_time") ?? c.req.query("start") ?? null;
  const endRaw = c.req.query("end_time") ?? c.req.query("end") ?? null;
  const startTime = startRaw && !Number.isNaN(new Date(startRaw).getTime()) ? new Date(startRaw) : null;
  const endTime = endRaw && !Number.isNaN(new Date(endRaw).getTime()) ? new Date(endRaw) : null;
  return {
    startTime,
    endTime,
    feedbackType: c.req.query("feedback_type") ?? null,
  };
}

async function fetchSessionsPage(
  offset: number,
  limit: number,
  filter: SessionFilter,
  singleId: string | null = null,
): Promise<SessionHistoryRow[]> {
  const conditions: string[] = ["s.deleted = false"];
  const params: unknown[] = [];
  if (singleId) {
    params.push(singleId);
    conditions.push(`s.id = $${params.length}::uuid`);
  }
  if (filter.startTime) {
    params.push(filter.startTime);
    conditions.push(`s.created_at >= $${params.length}::timestamptz`);
  }
  if (filter.endTime) {
    params.push(new Date(filter.endTime.getTime() + 1_000));
    conditions.push(`s.created_at <= $${params.length}::timestamptz`);
  }
  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;
  const res = await query<SessionHistoryRow>(
    `SELECT s.id, s.title, s.user_id, u.email AS user_email,
            s.persona_id, p.name AS persona_name, s.created_at,
            (SELECT count(*) FROM chat_message m
              WHERE m.chat_session_id = s.id) AS message_count
     FROM chat_session s
     LEFT JOIN onyx_user u ON u.id = s.user_id
     LEFT JOIN persona p ON p.id = s.persona_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY s.created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );
  return res.rows;
}

async function countSessions(filter: SessionFilter): Promise<number> {
  const conditions: string[] = ["s.deleted = false"];
  const params: unknown[] = [];
  if (filter.startTime) {
    params.push(filter.startTime);
    conditions.push(`s.created_at >= $${params.length}::timestamptz`);
  }
  if (filter.endTime) {
    params.push(new Date(filter.endTime.getTime() + 1_000));
    conditions.push(`s.created_at <= $${params.length}::timestamptz`);
  }
  const res = await query<{ n: string }>(
    `SELECT count(*) AS n FROM chat_session s WHERE ${conditions.join(" AND ")}`,
    params,
  );
  return Number(res.rows[0]?.n ?? 0);
}

/** First user + assistant message per session (batched over the page's ids). */
async function fetchFirstMessages(
  sessionIds: string[],
): Promise<Map<string, { user: string | null; assistant: string | null }>> {
  const result = new Map<string, { user: string | null; assistant: string | null }>();
  if (sessionIds.length === 0) return result;
  const res = await query<FirstMessageRow>(
    `SELECT DISTINCT ON (m.chat_session_id, m.role)
            m.chat_session_id, m.role, m.message
     FROM chat_message m
     WHERE m.chat_session_id = ANY($1::uuid[])
       AND m.role IN ('user', 'assistant')
     ORDER BY m.chat_session_id, m.role, m.message_index ASC`,
    [sessionIds],
  );
  for (const row of res.rows) {
    const entry = result.get(row.chat_session_id) ?? { user: null, assistant: null };
    if (row.role === "user" && entry.user === null) entry.user = row.message;
    if (row.role === "assistant" && entry.assistant === null) {
      entry.assistant = row.message;
    }
    result.set(row.chat_session_id, entry);
  }
  return result;
}

function sessionMinimalPayload(
  row: SessionHistoryRow,
  first: { user: string | null; assistant: string | null },
): Record<string, unknown> {
  return {
    // ChatSessionMinimal.id is typed number on the web side but flows through
    // links/keys unchanged; this port stores uuid session ids.
    id: row.id,
    user_email: row.user_email,
    name: row.title,
    first_user_message: first.user ?? "",
    first_ai_message: first.assistant ?? "",
    assistant_id: row.persona_id,
    assistant_name: row.persona_name,
    time_created: row.created_at.toISOString(),
    // No chat feedback table in this port.
    feedback_type: null,
    flow_type: "Chat",
    conversation_length: Number(row.message_count),
  };
}

// GET /admin/chat-session-history — paginated query-history table feed.
eeAdminRoutes.get("/chat-session-history", requireAdmin, async (c) => {
  const filter = parseSessionFilter(c);
  // Feedback filtering: with no feedback table, any like/dislike/mixed filter
  // matches nothing (sessions without feedback are excluded from that view).
  if (filter.feedbackType && filter.feedbackType !== "all") {
    return c.json({ items: [], total_items: 0 });
  }
  const pageNum = Math.max(0, Number(c.req.query("page_num") ?? "0") || 0);
  const pageSizeRaw = Number(c.req.query("page_size") ?? "20");
  const pageSize = Number.isInteger(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(pageSizeRaw, 500) : 20;
  const total = await countSessions(filter);
  const rows = await fetchSessionsPage(pageNum * pageSize, pageSize, filter);
  const firstMessages = await fetchFirstMessages(rows.map((r) => r.id));
  return c.json({
    items: rows.map((row) =>
      sessionMinimalPayload(row, firstMessages.get(row.id) ?? { user: null, assistant: null }),
    ),
    total_items: total,
  });
});

// GET /admin/chat-session-history/:id — ChatSessionSnapshot detail page.
eeAdminRoutes.get("/chat-session-history/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const rows = await fetchSessionsPage(0, 1, parseSessionFilter(c), id);
  const row = rows[0];
  if (!row) throw new NotFoundError("Chat session");
  const messagesRes = await query<{
    id: number;
    message: string;
    role: string;
    created_at: Date;
  }>(
    `SELECT id, message, role, created_at
     FROM chat_message
     WHERE chat_session_id = $1::uuid
     ORDER BY message_index ASC`,
    [id],
  );
  return c.json({
    id: row.id,
    user_email: row.user_email,
    name: row.title,
    assistant_id: row.persona_id,
    assistant_name: row.persona_name,
    time_created: row.created_at.toISOString(),
    flow_type: "Chat",
    messages: messagesRes.rows.map((m) => ({
      id: m.id,
      message: m.message,
      message_type: m.role,
      documents: [],
      feedback_type: null,
      feedback_text: null,
      time_created: m.created_at.toISOString(),
    })),
  });
});

// ---------------------------------------------------------------------------
// Query-history CSV export flow (KickoffCSVExport + exports modal)
// ---------------------------------------------------------------------------

interface QueryHistoryExport {
  requestId: string;
  start: string | null;
  end: string | null;
  status: "SUCCESS" | "FAILURE" | "PENDING" | "STARTED";
  startTime: string;
  csv: string | null;
}

const queryHistoryExports = new Map<string, QueryHistoryExport>();
const EXPORT_TTL_MS = 30 * 60_000;

function sweepExports(): void {
  const cutoff = Date.now() - EXPORT_TTL_MS;
  for (const [id, exportState] of queryHistoryExports) {
    if (new Date(exportState.startTime).getTime() < cutoff) {
      queryHistoryExports.delete(id);
    }
  }
}

function windowFromQuery(c: Context): { start: string | null; end: string | null } {
  const start = c.req.query("start") ?? c.req.query("start_time") ?? null;
  const end = c.req.query("end") ?? c.req.query("end_time") ?? null;
  return { start, end };
}

function buildSessionCsv(rows: SessionHistoryRow[], firsts: Map<string, { user: string | null; assistant: string | null }>): string {
  const header =
    "session_id,user_email,assistant_name,time_created,first_user_message,first_ai_message,conversation_length";
  const lines: string[] = [header];
  for (const row of rows) {
    const first = firsts.get(row.id) ?? { user: null, assistant: null };
    lines.push(
      [
        csvEscape(row.id),
        csvEscape(row.user_email),
        csvEscape(row.persona_name),
        csvEscape(row.created_at.toISOString()),
        csvEscape(first.user),
        csvEscape(first.assistant),
        Number(row.message_count),
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

// POST /admin/query-history/start-export?start=&end= -> {request_id}
eeAdminRoutes.post("/query-history/start-export", requireAdmin, async (c) => {
  sweepExports();
  const { start, end } = windowFromQuery(c);
  const requestId = crypto.randomUUID().replace(/-/g, "");
  const startDay = start && !Number.isNaN(new Date(start).getTime())
    ? new Date(start).toISOString().slice(0, 10)
    : "1970-01-01";
  const endDay = end && !Number.isNaN(new Date(end).getTime())
    ? new Date(end).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  // Single-node: build the CSV inline and mark the task SUCCESS immediately.
  const rows = await fetchSessionsPage(0, 5000, {
    startTime: start ? new Date(start) : null,
    endTime: end ? new Date(end) : null,
    feedbackType: null,
  });
  const firsts = await fetchFirstMessages(rows.map((r) => r.id));
  queryHistoryExports.set(requestId, {
    requestId,
    start,
    end,
    status: "SUCCESS",
    startTime: new Date().toISOString(),
    csv: buildSessionCsv(rows, firsts),
  });
  logger.info("query history export built", { requestId, startDay, endDay, rows: rows.length });
  return c.json({ request_id: requestId });
});

// GET /admin/query-history/export-status?request_id= -> {status}
eeAdminRoutes.get("/query-history/export-status", requireAdmin, (c) => {
  const requestId = c.req.query("request_id") ?? "";
  const exportState = queryHistoryExports.get(requestId);
  return c.json({ status: exportState?.status ?? "FAILURE" });
});

// GET /admin/query-history/download?request_id= -> CSV
eeAdminRoutes.get("/query-history/download", requireAdmin, (c) => {
  const requestId = c.req.query("request_id") ?? "";
  const exportState = queryHistoryExports.get(requestId);
  if (!exportState || !exportState.csv) throw new NotFoundError("Query history export");
  return new Response(exportState.csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="query_history_${requestId}.csv"`,
    },
  });
});

// GET /admin/query-history/list -> TaskQueueState[]
eeAdminRoutes.get("/query-history/list", requireAdmin, (c) => {
  sweepExports();
  return c.json(
    [...queryHistoryExports.values()].map((e) => ({
      task_id: e.requestId,
      start: e.start ?? "1970-01-01T00:00:00.000Z",
      end: e.end ?? new Date().toISOString(),
      status: e.status,
      start_time: e.startTime,
    })),
  );
});

// ---------------------------------------------------------------------------
// SCIM token (ScimPage)
// ---------------------------------------------------------------------------

interface ScimTokenRow {
  id: number;
  name: string;
  token_display: string;
  is_active: boolean;
  created_at: Date;
  last_used_at: Date | null;
  idp_domain: string | null;
}

function scimTokenPayload(row: ScimTokenRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    token_display: row.token_display,
    is_active: row.is_active,
    created_at: row.created_at.toISOString(),
    last_used_at: row.last_used_at ? row.last_used_at.toISOString() : null,
    idp_domain: row.idp_domain,
  };
}

function generateScimSecret(): { raw: string; display: string; hash: string } {
  const raw = `onyx_scim_${crypto.randomUUID().replace(/-/g, "")}${crypto
    .randomUUID()
    .replace(/-/g, "")}`;
  return {
    raw,
    display: `${raw.slice(0, 10)}...${raw.slice(-4)}`,
    hash: createHash("sha256").update(raw).digest("hex"),
  };
}

// GET /admin/enterprise-settings/scim/token -> ScimTokenResponse | null.
eeAdminRoutes.get("/enterprise-settings/scim/token", requireAdmin, async (c) => {
  const row = await queryOne<ScimTokenRow>(
    `SELECT id, name, token_display, is_active, created_at, last_used_at, idp_domain
     FROM scim_token
     WHERE is_active
     ORDER BY id DESC
     LIMIT 1`,
  );
  return c.json(row ? scimTokenPayload(row) : null);
});

// POST /admin/enterprise-settings/scim/token (body {name}) — create/rotate.
// PUT is a task-spec alias with the same rotate semantics.
async function rotateScimToken(c: Context) {
  const auth = getAuth(c);
  const body = await readJson(c);
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "default";
  const { raw, display, hash } = generateScimSecret();
  // One active token at a time: retire prior rows, insert the new one.
  await query(`UPDATE scim_token SET is_active = false WHERE is_active`);
  const created = await queryOne<ScimTokenRow>(
    `INSERT INTO scim_token (name, token_hash, token_display)
     VALUES ($1, $2, $3)
     RETURNING id, name, token_display, is_active, created_at, last_used_at, idp_domain`,
    [name, hash, display],
  );
  if (!created) throw new NotFoundError("SCIM token");
  logger.info("scim token rotated", { actor: auth?.user.email ?? "unknown", id: created.id });
  return c.json({
    ...scimTokenPayload(created),
    raw_token: raw,
  });
}
eeAdminRoutes.post("/enterprise-settings/scim/token", requireAdmin, rotateScimToken);
eeAdminRoutes.put("/enterprise-settings/scim/token", requireAdmin, rotateScimToken);

// ---------------------------------------------------------------------------
// Log export (ExportLogsPage)
// ---------------------------------------------------------------------------

interface LogExportState {
  exportId: string;
  startedAt: number;
  state: "collecting" | "ready";
}

const logExports = new Map<string, LogExportState>();
const LOG_EXPORT_TTL_MS = 60 * 60_000;

function sweepLogExports(): void {
  const cutoff = Date.now() - LOG_EXPORT_TTL_MS;
  for (const [id, exportState] of logExports) {
    if (exportState.startedAt < cutoff) logExports.delete(id);
  }
}

// POST /admin/log-export -> {export_id}; completes immediately.
eeAdminRoutes.post("/log-export", requireAdmin, (c) => {
  sweepLogExports();
  const exportId = crypto.randomUUID().replace(/-/g, "");
  logExports.set(exportId, {
    exportId,
    startedAt: Date.now(),
    state: "ready",
  });
  logger.info("log export started (immediate completion)", { exportId });
  return c.json({ export_id: exportId });
});

// GET /admin/log-export/:exportId -> LogExportStatus.
eeAdminRoutes.get("/log-export/:exportId", requireAdmin, (c) => {
  sweepLogExports();
  const exportId = c.req.param("exportId");
  const exportState = logExports.get(exportId);
  if (!exportState) throw new NotFoundError("Log export");
  return c.json({
    export_id: exportId,
    state: exportState.state,
    receipts: [
      {
        worker_name: "api-server",
        hostname: hostname(),
        status: "uploaded",
        file_count: 0,
        size_bytes: 0,
        error: null,
      },
    ],
    pending_worker_names: [],
  });
});

// GET /admin/log-export/:exportId/download — stub bundle (ExportLogsPage
// downloads a blob; the body is a small text bundle describing the stub).
eeAdminRoutes.get("/log-export/:exportId/download", requireAdmin, (c) => {
  sweepLogExports();
  const exportId = c.req.param("exportId");
  const exportState = logExports.get(exportId);
  if (!exportState) throw new NotFoundError("Log export");
  const body = [
    "onyx log export bundle (stub)",
    `export_id: ${exportId}`,
    `generated_at: ${new Date().toISOString()}`,
    "file_count: 0",
  ].join("\n");
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="onyx_logs_${exportId}.zip"`,
    },
  });
});
