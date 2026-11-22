/**
 * Hono app definition — shared by the Bun entry (src/index.ts, port 8080)
 * and the Vercel serverless entry (api/[...path].ts).
 *
 * Extracted verbatim from the former src/index.ts so both runtimes mount the
 * identical route surface (mirrors FastAPI router inclusion in onyx.main.build_app).
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { getLogger } from "../utils/logger.js";
import { AuthError, OnyxError } from "../utils/errors.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { manageStateRoutes } from "./routes/manage_state.js";
import { manageUsersRoutes } from "./routes/manage_users.js";
import { userGroupRoutes } from "./routes/user_groups.js";
import { standardAnswerRoutes } from "./routes/standard_answers.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { eeAdminRoutes } from "./routes/ee_admin.js";
import { settingsRoutes } from "./routes/settings.js";
import { notificationsRoutes } from "./routes/notifications.js";
import { llmRoutes, adminLlmRoutes } from "./routes/llm.js";
import { chatRoutes } from "./routes/chat.js";
import { searchRoutes } from "./routes/search.js";
import { documentsRoutes } from "./routes/documents.js";
import { connectorsRoutes } from "./routes/connectors.js";
import { adminRoutes } from "./routes/admin.js";
import { personasRoutes } from "./routes/personas.js";
import { toolsRoutes } from "./routes/tools.js";
import { artifactsRoutes } from "./routes/artifacts.js";
import { mcpRoutes } from "./routes/mcp.js";
import { integrationsRoutes } from "./routes/integrations.js";
import { featuresRoutes } from "./routes/features.js";
import { adminSurfaceRoutes } from "./routes/admin_surface.js";
import { voiceRoutes } from "./routes/voice.js";
import { buildRoutes } from "./routes/build.js";

const logger = getLogger("api.server");

const app = new Hono();

app.use("*", cors());
app.onError((err, c) => {
  // Port of FastAPI HTTPException semantics: {"detail": <literal>}
  if (err instanceof AuthError) {
    return c.json({ detail: err.detail }, err.httpStatus as 400);
  }
  if (err instanceof OnyxError) {
    return c.json({ detail: err.message, code: err.code }, err.httpStatus as 400);
  }
  logger.error("unhandled error", { error: String(err), path: c.req.path });
  return c.json({ detail: "Internal server error" }, 500);
});

// Port of FastAPI's default 404 handler: unmatched routes respond
// {"detail":"Not Found"} as JSON. The original frontend's parseFetcherResponse
// calls res.json() on every failure — a plain-text 404 raises SyntaxError
// inside the fetcher and breaks error classification (isNotFoundError).
app.notFound((c) => {
  return c.json({ detail: "Not Found" }, 404);
});

// Route mounts (mirrors FastAPI router inclusion in onyx.main.build_app)
app.route("/health", healthRoutes);
app.route("/auth", authRoutes);
app.route("/", manageStateRoutes); // /auth/type, /version (get_state.py)
app.route("/", manageUsersRoutes); // /me (server/manage/users.py)
app.route("/manage", userGroupRoutes); // /manage/admin/user-group (+ permissions registry, minimal groups) — EE
app.route("/manage", standardAnswerRoutes); // /manage/admin/standard-answer — EE
app.route("/", analyticsRoutes); // /user/usage, /admin/usage/*, /admin/usage-report, /analytics/admin/* — EE
app.route("/admin", eeAdminRoutes); // /admin/chat-session-history, scim token, log/query-history exports — EE
app.route("/", settingsRoutes); // /settings (server/settings/api.py)
app.route("/", notificationsRoutes); // /notifications (features/notifications/api.py)
app.route("/", llmRoutes); // /llm/provider (server/manage/llm/api.py)
app.route("/", adminLlmRoutes); // /admin/llm/provider admin surface
app.route("/chat", chatRoutes);
app.route("/search", searchRoutes);
app.route("/documents", documentsRoutes);
app.route("/manage", adminRoutes); // connectors/credentials/cc-pairs admin surface
app.route("/persona", personasRoutes); // /persona surface (server/features/persona/api.py)
app.route("/tools", toolsRoutes);
app.route("/tool", toolsRoutes); // GET /tool — original surface (list[ToolSnapshot])
app.route("/", integrationsRoutes); // /integrations surface
app.route("/artifacts", artifactsRoutes);
app.route("/mcp", mcpRoutes);
app.route("/", featuresRoutes); // /input_prompt, /mcp/servers, /query/valid-tags, ... feature read paths
app.route("/", adminSurfaceRoutes); // admin-surface fill-ins (license, search-settings, index-monitoring, ...)
app.route("/", voiceRoutes); // /voice/* — TTS synthesis + voice settings
app.route("/build", buildRoutes); // /build/* — Onyx Craft (sessions, streaming, artifacts)

export { app };
