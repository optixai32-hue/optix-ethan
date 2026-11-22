/**
 * EE usage + analytics surface — Task 4. Port of:
 *   - backend/onyx/server/usage/user_usage.py        (GET /user/usage)
 *   - backend/onyx/server/usage/system_usage.py      (GET /admin/usage/system,
 *     GET /admin/usage/export, POST /admin/usage/reset)
 *   - backend/onyx/server/usage/usage_report.py      (GET/POST /admin/usage-report,
 *     GET /admin/usage-report/:report_name)
 *   - backend/onyx/server/ee/analytics.py            (GET /analytics/admin/query,
 *     /user, /onyxbot, /persona/messages, /persona/unique-users)
 *
 * Frontend contract (verified against /home/z/onyx/web/src):
 *   - GET /user/usage -> UserUsageResponse (web/src/app/app/settings/usage/lib.ts)
 *   - GET /admin/usage/system -> SystemUsageResponse
 *     (web/src/lib/usage/systemUsage.ts: {start, end, categories: [{category,
 *      totals, records: [{attribution, model, flow, provider, day, *_tokens,
 *      cost_cents}]}]})
 *   - GET /admin/usage/export -> UsageExportResponse (web/src/lib/usage/userUsage.ts)
 *   - POST /admin/usage/reset -> no-op {success: true}
 *   - GET /admin/usage-report -> UsageReport[]
 *     (web/src/app/ee/admin/performance/usage/types.ts: {report_name, requestor,
 *      time_created, period_from, period_to}); POST body {period_from,
 *      period_to, report_id} and the report_name must CONTAIN report_id so the
 *      pending-row matcher (UsageReports.tsx) can pair it.
 *   - GET /analytics/admin/query  -> QueryAnalytics[]
 *     (web/src/lib/usage/interfaces.ts: {total_queries, total_likes,
 *      total_dislikes, date}); same module for user/onyxbot/persona shapes.
 *
 * Query params: /user/usage, /admin/usage/* accept `start`/`end` as either
 * YYYY-MM-DD (formatDateForApiParam) or ISO datetimes (hooks.ts analyticsRange);
 * /analytics/admin/* accept ISO `start`/`end` plus `persona_id` on persona
 * routes. All buckets are UTC days ("YYYY-MM-DD").
 *
 * There is no token/feedback telemetry in this port's schema, so per-day token
 * counts are estimated from message length (~4 chars/token) and cost stays at
 * zero cents; likes/dislikes are always 0. Response SHAPES are exact.
 */
import { Hono, type Context } from "hono";
import { getAuth, requireAdmin, requireAuth } from "../../auth/middleware.js";
import { query, queryOne } from "../../db/client.js";
import { NotFoundError } from "../../utils/errors.js";
import { getLogger } from "../../utils/logger.js";

const logger = getLogger("server.routes.analytics");

export const analyticsRoutes = new Hono();

// ---------------------------------------------------------------------------
// Date-window helpers
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_DAYS = 30;

interface UsageWindow {
  start: Date;
  end: Date;
  startRaw: string;
  endRaw: string;
}

function parseWindowParam(raw: string | undefined, fallback: Date, endOfDay = false): Date {
  if (!raw) return fallback;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return fallback;
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    parsed.setUTCHours(23, 59, 59, 999);
  }
  return parsed;
}

function resolveWindow(c: Context): UsageWindow {
  const now = new Date();
  const defaultStart = new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);
  return {
    start: parseWindowParam(c.req.query("start"), defaultStart),
    end: parseWindowParam(c.req.query("end"), now, true),
    startRaw: c.req.query("start") ?? defaultStart.toISOString(),
    endRaw: c.req.query("end") ?? now.toISOString(),
  };
}

/** Day window params for SQL (start inclusive, end exclusive at day+1). */
function dayWindow(window: UsageWindow): { startDay: string; endDay: string } {
  const startDay = window.start.toISOString().slice(0, 10);
  const endExclusive = new Date(window.end.getTime() + 1_000);
  const endDay = endExclusive.toISOString().slice(0, 10);
  return { startDay, endDay };
}

const DAY = "YYYY-MM-DD";

// ---------------------------------------------------------------------------
// Usage aggregation (token estimate: ~4 chars per token)
// ---------------------------------------------------------------------------

interface UsageRecord {
  attribution: "ATTRIBUTED" | "UNATTRIBUTED";
  model: string;
  flow: string;
  provider: string;
  day: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_cents: number;
}

interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_cents: number;
}

interface ModelConfigRow {
  default_model_name: string | null;
  provider: string | null;
}

async function defaultModelConfig(): Promise<{ model: string; provider: string }> {
  const row = await queryOne<ModelConfigRow>(
    `SELECT default_model_name, provider
     FROM llm_provider
     ORDER BY is_default DESC, id ASC
     LIMIT 1`,
  );
  return {
    model: row?.default_model_name ?? "unknown",
    provider: row?.provider ?? "unknown",
  };
}

/**
 * Per-day usage records joined with the sending user's email. Attribution
 * mirrors the SystemUsageRecord vocabulary; a session without a user is
 * UNATTRIBUTED. Tokens are estimated from message length (no token telemetry
 * in this schema); cost is 0 cents (no price telemetry either).
 */
async function fetchUsageRecords(
  startDay: string,
  endDay: string,
  userEmail: string | null = null,
): Promise<UsageRecord[]> {
  const res = await query<{
    day: string;
    role: string;
    chars: string;
    user_id: string | null;
    email: string | null;
  }>(
    `SELECT to_char(m.created_at, $3) AS day, m.role,
            COALESCE(sum(length(m.message)), 0) AS chars,
            s.user_id, u.email
     FROM chat_message m
     JOIN chat_session s ON s.id = m.chat_session_id
     LEFT JOIN onyx_user u ON u.id = s.user_id
     WHERE m.created_at >= $1::timestamptz
       AND m.created_at < ($2::date + interval '1 day')
       ${userEmail ? "AND u.email = $4" : ""}
     GROUP BY day, m.role, s.user_id, u.email
     ORDER BY day ASC`,
    userEmail
      ? [startDay, endDay, DAY, userEmail]
      : [startDay, endDay, DAY],
  );

  const { model, provider } = await defaultModelConfig();
  // Merge user+assistant rows per day/attribution into one record each.
  const merged = new Map<string, UsageRecord>();
  for (const row of res.rows) {
    const attribution = row.user_id === null ? "UNATTRIBUTED" : "ATTRIBUTED";
    const key = `${row.day}|${attribution}`;
    const record =
      merged.get(key) ??
      ({
        attribution,
        model,
        flow: "chat",
        provider,
        day: row.day,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_cents: 0,
      } satisfies UsageRecord);
    const tokens = Math.ceil(Number(row.chars) / 4);
    if (row.role === "user") record.input_tokens += tokens;
    else record.output_tokens += tokens;
    merged.set(key, record);
  }
  return [...merged.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function totalsOf(records: UsageRecord[]): UsageTotals {
  return records.reduce(
    (sum, r) => ({
      input_tokens: sum.input_tokens + r.input_tokens,
      output_tokens: sum.output_tokens + r.output_tokens,
      cache_read_tokens: sum.cache_read_tokens + r.cache_read_tokens,
      cache_creation_tokens: sum.cache_creation_tokens + r.cache_creation_tokens,
      cost_cents: sum.cost_cents + r.cost_cents,
    }),
    {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_cents: 0,
    },
  );
}

function csvEscape(value: string | number | null): string {
  const raw = value === null ? "" : String(value);
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

// ---------------------------------------------------------------------------
// /user/usage (settings/usage page) — UserUsageResponse
// ---------------------------------------------------------------------------

analyticsRoutes.get("/user/usage", requireAuth, async (c) => {
  const auth = getAuth(c);
  if (!auth) return c.json({ detail: "Unauthorized" }, 401);
  const window = resolveWindow(c);
  const { startDay, endDay } = dayWindow(window);
  const records = await fetchUsageRecords(startDay, endDay, auth.user.email);

  // Per-day-per-model rows (UsagePerDayByModel): one model in this port, so
  // records merge 1:1 into rows.
  const perDayByModel = records.map((r) => ({
    day: r.day,
    model: r.model,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cache_read_tokens: r.cache_read_tokens,
    cache_creation_tokens: r.cache_creation_tokens,
    cost_cents: r.cost_cents,
  }));
  const totals = totalsOf(records);
  return c.json({
    per_day_by_model: perDayByModel,
    window_cost_cents: totals.cost_cents,
    // No per-user cost budgets in this port (BudgetSection empty state).
    budget_cents: null,
    budget_remaining_cents: null,
    budget_period_hours: null,
    budget_reset_at: null,
    selected_model_price: null,
    available_model_prices: [],
  });
});

// ---------------------------------------------------------------------------
// /admin/usage/* — SystemUsageResponse, export, reset
// ---------------------------------------------------------------------------

analyticsRoutes.get("/admin/usage/system", requireAdmin, async (c) => {
  const window = resolveWindow(c);
  const { startDay, endDay } = dayWindow(window);
  const records = await fetchUsageRecords(startDay, endDay);
  // One "chat" flow category; records keep the attribution split.
  const categories = [
    {
      category: "chat",
      totals: totalsOf(records),
      records,
    },
  ];
  return c.json({
    start: window.start.toISOString(),
    end: window.end.toISOString(),
    categories,
  });
});

analyticsRoutes.get("/admin/usage/export", requireAdmin, async (c) => {
  const window = resolveWindow(c);
  const { startDay, endDay } = dayWindow(window);
  const emailsRes = await query<{ email: string }>(
    `SELECT DISTINCT u.email
     FROM chat_message m
     JOIN chat_session s ON s.id = m.chat_session_id
     JOIN onyx_user u ON u.id = s.user_id
     WHERE m.created_at >= $1::timestamptz
       AND m.created_at < ($2::date + interval '1 day')
     ORDER BY u.email ASC`,
    [startDay, endDay],
  );
  const users = await Promise.all(
    emailsRes.rows.map(async (row) => {
      const records = await fetchUsageRecords(startDay, endDay, row.email);
      return { email: row.email, totals: totalsOf(records), records };
    }),
  );
  return c.json({
    start: window.start.toISOString(),
    end: window.end.toISOString(),
    users,
  });
});

analyticsRoutes.post("/admin/usage/reset", requireAdmin, (c) => {
  // Port of the admin reset endpoint's contract; there are no cached usage
  // aggregates in this port, so the reset is a no-op that reports success.
  logger.info("admin usage reset requested (no-op)");
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// /admin/usage-report — UsageReport[] registry + CSV generation/download
// ---------------------------------------------------------------------------

interface UsageReportRow {
  report_name: string;
  requestor: string | null;
  period_from: Date | null;
  period_to: Date | null;
  content: string | null;
  time_created: Date;
}

function reportPayload(row: UsageReportRow): Record<string, unknown> {
  return {
    report_name: row.report_name,
    requestor: row.requestor,
    time_created: row.time_created.toISOString(),
    period_from: row.period_from ? row.period_from.toISOString() : null,
    period_to: row.period_to ? row.period_to.toISOString() : null,
  };
}

function buildUsageCsv(
  startDay: string,
  endDay: string,
): Promise<string> {
  return (async () => {
    const emailsRes = await query<{ email: string }>(
      `SELECT DISTINCT u.email
       FROM chat_message m
       JOIN chat_session s ON s.id = m.chat_session_id
       JOIN onyx_user u ON u.id = s.user_id
       WHERE m.created_at >= $1::timestamptz
         AND m.created_at < ($2::date + interval '1 day')
       ORDER BY u.email ASC`,
      [startDay, endDay],
    );
    const header =
      "user_email,day,model,flow,provider,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,cost_cents";
    const lines: string[] = [header];
    for (const { email } of emailsRes.rows) {
      const records = await fetchUsageRecords(startDay, endDay, email);
      for (const r of records) {
        lines.push(
          [
            csvEscape(email),
            csvEscape(r.day),
            csvEscape(r.model),
            csvEscape(r.flow),
            csvEscape(r.provider),
            r.input_tokens,
            r.output_tokens,
            r.cache_read_tokens,
            r.cache_creation_tokens,
            r.cost_cents,
          ].join(","),
        );
      }
    }
    return `${lines.join("\n")}\n`;
  })();
}

analyticsRoutes.get("/admin/usage-report", requireAdmin, async (c) => {
  const res = await query<UsageReportRow>(
    `SELECT report_name, requestor, period_from, period_to, content, time_created
     FROM usage_report
     ORDER BY time_created DESC`,
  );
  return c.json(res.rows.map((row) => reportPayload(row)));
});

analyticsRoutes.post("/admin/usage-report", requireAdmin, async (c) => {
  const auth = getAuth(c);
  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  // UsageReports.tsx sends {period_from, period_to, report_id} and pairs the
  // finished row by report_name.includes(report_id).
  const reportId =
    typeof body.report_id === "string" && body.report_id
      ? body.report_id
      : crypto.randomUUID();
  const periodFromRaw = typeof body.period_from === "string" ? body.period_from : null;
  const periodToRaw = typeof body.period_to === "string" ? body.period_to : null;
  const periodFrom = periodFromRaw ? new Date(periodFromRaw) : null;
  const periodTo = periodToRaw ? new Date(periodToRaw) : null;
  const validPeriod = (d: Date | null): d is Date => d !== null && !Number.isNaN(d.getTime());

  const startDay = validPeriod(periodFrom) ? periodFrom.toISOString().slice(0, 10) : "1970-01-01";
  const endDay = validPeriod(periodTo) ? periodTo.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  const content = await buildUsageCsv(startDay, endDay);
  const reportName = `usage_report_${startDay}_${endDay}_${reportId}.csv`;

  await query(
    `INSERT INTO usage_report (report_name, requestor, period_from, period_to, content)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (report_name) DO UPDATE
       SET content = EXCLUDED.content, time_created = now()`,
    [
      reportName,
      auth?.user.email ?? null,
      validPeriod(periodFrom) ? periodFrom : null,
      validPeriod(periodTo) ? periodTo : null,
      content,
    ],
  );
  logger.info("usage report generated", { reportName });
  return c.json({ report_name: reportName, report_id: reportId });
});

analyticsRoutes.get("/admin/usage-report/:reportName", requireAdmin, async (c) => {
  const reportName = c.req.param("reportName");
  const row = await queryOne<UsageReportRow>(
    `SELECT report_name, requestor, period_from, period_to, content, time_created
     FROM usage_report WHERE report_name = $1`,
    [reportName],
  );
  if (!row) throw new NotFoundError("Usage report");
  return new Response(row.content ?? "", {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${reportName}"`,
    },
  });
});

// ---------------------------------------------------------------------------
// /analytics/admin/* — date-bucketed analytics (lib/usage/interfaces.ts)
// ---------------------------------------------------------------------------

interface DayCountRow {
  day: string;
  n: string;
}

analyticsRoutes.get("/analytics/admin/query", requireAdmin, async (c) => {
  const window = resolveWindow(c);
  const { startDay, endDay } = dayWindow(window);
  const res = await query<DayCountRow>(
    `SELECT to_char(m.created_at, $3) AS day, count(*) AS n
     FROM chat_message m
     WHERE m.role = 'user'
       AND m.created_at >= $1::timestamptz
       AND m.created_at < ($2::date + interval '1 day')
     GROUP BY day
     ORDER BY day ASC`,
    [startDay, endDay, DAY],
  );
  // No feedback table in this port: likes/dislikes stay 0.
  return c.json(
    res.rows.map((row) => ({
      total_queries: Number(row.n),
      total_likes: 0,
      total_dislikes: 0,
      date: row.day,
    })),
  );
});

analyticsRoutes.get("/analytics/admin/user", requireAdmin, async (c) => {
  const window = resolveWindow(c);
  const { startDay, endDay } = dayWindow(window);
  const res = await query<DayCountRow>(
    `SELECT to_char(m.created_at, $3) AS day,
            count(DISTINCT s.user_id) AS n
     FROM chat_message m
     JOIN chat_session s ON s.id = m.chat_session_id
     WHERE m.role = 'user'
       AND s.user_id IS NOT NULL
       AND m.created_at >= $1::timestamptz
       AND m.created_at < ($2::date + interval '1 day')
     GROUP BY day
     ORDER BY day ASC`,
    [startDay, endDay, DAY],
  );
  return c.json(
    res.rows.map((row) => ({
      total_active_users: Number(row.n),
      date: row.day,
    })),
  );
});

analyticsRoutes.get("/analytics/admin/onyxbot", requireAdmin, async (c) => {
  const window = resolveWindow(c);
  const { startDay, endDay } = dayWindow(window);
  const res = await query<DayCountRow>(
    `SELECT to_char(m.created_at, $3) AS day, count(*) AS n
     FROM chat_message m
     WHERE m.role = 'assistant'
       AND m.created_at >= $1::timestamptz
       AND m.created_at < ($2::date + interval '1 day')
     GROUP BY day
     ORDER BY day ASC`,
    [startDay, endDay, DAY],
  );
  // auto_resolved requires Slack-bot resolution tracking; reported as 0.
  return c.json(
    res.rows.map((row) => ({
      total_queries: Number(row.n),
      auto_resolved: 0,
      date: row.day,
    })),
  );
});

analyticsRoutes.get(
  "/analytics/admin/persona/messages",
  requireAdmin,
  async (c) => {
    const window = resolveWindow(c);
    const { startDay, endDay } = dayWindow(window);
    const personaIdRaw = c.req.query("persona_id");
    const personaId = personaIdRaw ? Number(personaIdRaw) : null;
    const params: unknown[] = personaId !== null
      ? [startDay, endDay, DAY, personaId]
      : [startDay, endDay, DAY];
    const res = await query<DayCountRow>(
      `SELECT to_char(m.created_at, $3) AS day, count(*) AS n
       FROM chat_message m
       JOIN chat_session s ON s.id = m.chat_session_id
       WHERE s.persona_id ${personaId !== null ? "= $4" : "IS NOT NULL"}
         AND m.role = 'assistant'
         AND m.created_at >= $1::timestamptz
         AND m.created_at < ($2::date + interval '1 day')
       GROUP BY day, s.persona_id
       ORDER BY day ASC`,
      params,
    );
    return c.json(
      res.rows.map((row) => ({
        total_messages: Number(row.n),
        date: row.day,
        persona_id: personaId ?? 0,
      })),
    );
  },
);

analyticsRoutes.get(
  "/analytics/admin/persona/unique-users",
  requireAdmin,
  async (c) => {
    const window = resolveWindow(c);
    const { startDay, endDay } = dayWindow(window);
    const personaIdRaw = c.req.query("persona_id");
    const personaId = personaIdRaw ? Number(personaIdRaw) : null;
    const params: unknown[] = personaId !== null
      ? [startDay, endDay, DAY, personaId]
      : [startDay, endDay, DAY];
    const res = await query<DayCountRow>(
      `SELECT to_char(m.created_at, $3) AS day,
              count(DISTINCT s.user_id) AS n
       FROM chat_message m
       JOIN chat_session s ON s.id = m.chat_session_id
       WHERE s.persona_id ${personaId !== null ? "= $4" : "IS NOT NULL"}
         AND s.user_id IS NOT NULL
         AND m.created_at >= $1::timestamptz
         AND m.created_at < ($2::date + interval '1 day')
       GROUP BY day, s.persona_id
       ORDER BY day ASC`,
      params,
    );
    return c.json(
      res.rows.map((row) => ({
        unique_users: Number(row.n),
        date: row.day,
        persona_id: personaId ?? 0,
      })),
    );
  },
);
