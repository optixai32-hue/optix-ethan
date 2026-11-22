/**
 * Feature-surface endpoints required by the original Onyx web app — TypeScript
 * ports of the corresponding Python handlers. These are the read paths the
 * /app chat surface calls on load; unimplemented feature data returns its
 * faithful "empty" shape, never fabricated content:
 *
 *   - GET /input_prompt                -> list (server/features/input_prompt/api.py)
 *   - GET /mcp/servers                 -> MCPServersResponse (server/features/mcp/api.py:1531)
 *   - GET /mcp/servers/persona/{id}    -> MCPServersResponse (server/features/mcp/api.py:1489)
 *   - GET /query/valid-tags            -> TagResponse (server/query_and_chat/query_backend.py:85)
 *   - GET /notifications/summary       -> NotificationSummary (features/notifications)
 *   - GET /manage/document-set         -> list (server/manage/document_set/api.py)
 *   - GET /manage/connector-status     -> list (server/documents/connector.py)
 *   - GET /user/projects               -> list (server/features/projects/api.py)
 *   - GET /user/files/recent           -> list (user files)
 *   - GET /enterprise-settings         -> EnterpriseSettings (OSS null-branding shape)
 *   - GET /voice/status                -> VoiceStatusResponse (manage/voice/user_api.py:50)
 *   - GET /federated                   -> list (federated connectors)
 *   - GET /federated/oauth-status      -> list
 *   - GET /user-oauth-token/status     -> list
 *   - GET /chat/incognito-availability -> bool
 */
import { Hono } from "hono";
import { query } from "../../db/client.js";
import { requireAuth } from "../../auth/middleware.js";
import { catalogMcpServers } from "./mcp_catalog_view.js";

export const featuresRoutes = new Hono();

// ---------------------------------------------------------------------------
// Input prompts (server/features/input_prompt/api.py list_input_prompts)
// ---------------------------------------------------------------------------

featuresRoutes.get("/input_prompt", requireAuth, async (c) => {
  // No input_prompt table in this port yet — the user has no saved prompts,
  // which is the same result as fetch_input_prompts_by_user for a fresh user.
  return c.json([]);
});

// ---------------------------------------------------------------------------
// MCP servers (server/features/mcp/api.py)
// ---------------------------------------------------------------------------

featuresRoutes.get("/mcp/servers", requireAuth, async (c) => {
  // get_mcp_servers_for_user — cloud-parity plugin catalog (see
  // mcp_catalog_view.ts): every entry is an available-to-connect server.
  return c.json({ mcp_servers: catalogMcpServers() });
});

featuresRoutes.get("/mcp/servers/craft", requireAuth, async (c) => {
  // Craft-surface listing (SWR_KEYS.mcpServersCraft): catalog entries marked
  // available_in_craft.
  return c.json({
    mcp_servers: catalogMcpServers().filter(
      (s) => (s as Record<string, unknown>).available_in_craft === true,
    ),
  });
});

featuresRoutes.get("/mcp/servers/persona/:assistantId", requireAuth, async (c) => {
  // get_mcp_servers_for_assistant — persona-scoped listing; the default
  // assistant exposes the full catalog (no per-agent restriction in this port).
  return c.json({
    assistant_id: c.req.param("assistantId"),
    mcp_servers: catalogMcpServers(),
  });
});

// ---------------------------------------------------------------------------
// Valid tags (server/query_and_chat/query_backend.py get_tags)
// ---------------------------------------------------------------------------

featuresRoutes.get("/query/valid-tags", requireAuth, async (c) => {
  // TagResponse { tags: list[SourceTag] } — tags come from indexed documents'
  // metadata; return the distinct tag_key/tag_value pairs stored on chunks.
  const result = await query<{ tag_key: string; tag_value: string }>(
    `SELECT DISTINCT tag_key, tag_value FROM (
       SELECT metadata->>'tag_key' AS tag_key, metadata->>'tag_value' AS tag_value
       FROM chunk
     ) t WHERE tag_key IS NOT NULL AND tag_value IS NOT NULL LIMIT 50`,
  );
  return c.json({ tags: result.rows });
});

// ---------------------------------------------------------------------------
// Notifications summary (server/features/notifications)
// ---------------------------------------------------------------------------

featuresRoutes.get("/notifications/summary", requireAuth, async (c) => {
  // NotificationSummary { total_items, undismissed_count } — the notifications
  // table is not part of this port; the empty summary is the faithful result.
  return c.json({ total_items: 0, undismissed_count: 0 });
});

// ---------------------------------------------------------------------------
// Document sets (server/manage/document_set/api.py list_document_sets)
// ---------------------------------------------------------------------------

featuresRoutes.get("/manage/document-set", requireAuth, async (c) => {
  // list[DocumentSetSnapshot] — no document_set rows in this port yet.
  return c.json([]);
});

// ---------------------------------------------------------------------------
// Connector status (server/documents/connector.py)
// ---------------------------------------------------------------------------

featuresRoutes.get("/manage/connector-status", requireAuth, async (c) => {
  // list[ConnectorStatus] — derived from index attempts; none recorded yet.
  return c.json([]);
});

// ---------------------------------------------------------------------------
// User projects (server/features/projects/api.py)
// ---------------------------------------------------------------------------

featuresRoutes.get("/user/projects", requireAuth, async (c) => {
  // list[ProjectSnapshot] — projects feature not ported yet.
  return c.json([]);
});

// ---------------------------------------------------------------------------
// Recent user files
// ---------------------------------------------------------------------------

featuresRoutes.get("/user/files/recent", requireAuth, async (c) => {
  // list of recently uploaded file descriptors; none yet.
  return c.json([]);
});

// ---------------------------------------------------------------------------
// Enterprise settings (OSS shape — null branding, no custom navigation)
// ---------------------------------------------------------------------------

featuresRoutes.get("/enterprise-settings", requireAuth, async (c) => {
  return c.json({
    application_name: null,
    use_custom_logo: false,
    use_custom_logotype: false,
    logo_display_style: null,
    custom_nav_items: [],
    custom_lower_disclaimer_content: null,
    custom_header_content: null,
    two_lines_for_chat_header: null,
    custom_popup_header: null,
    custom_popup_content: null,
    enable_consent_screen: null,
    consent_screen_prompt: null,
    show_first_visit_notice: null,
    custom_greeting_message: null,
    custom_login_subtitle: null,
    custom_help_link_url: null,
    custom_help_link_label: null,
  });
});

// ---------------------------------------------------------------------------
// Voice status moved to voice.ts (TTS provisioned via the z-ai audio surface).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Application logo (web/src/app/app/components/AppPopup.tsx and other
// consumers request /api/enterprise-settings/logo; the Python backend serves
// the uploaded file). This port serves the default Onyx mark — the same SVG
// the frontend ships at web/public/logo.svg — so every <img> consumer renders
// the real logo instead of a broken image.
// ---------------------------------------------------------------------------

const ONYX_LOGO_SVG = `<svg viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M27.9998 0L10.8691 7.76944L27.9998 15.5389L45.1305 7.76944L27.9998 0ZM27.9998 40.4611L10.8691 48.2306L27.9998 56L45.1305 48.2306L27.9998 40.4611ZM48.2309 10.8691L56.0001 28.0003L48.2309 45.1314L40.4617 28.0003L48.2309 10.8691ZM15.5385 28.0001L7.76923 10.869L0 28.0001L7.76923 45.1313L15.5385 28.0001Z" fill="black"/></svg>`;

featuresRoutes.get("/enterprise-settings/logo", (c) => {
  return new Response(ONYX_LOGO_SVG, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=86400",
    },
  });
});

// ---------------------------------------------------------------------------
// Federated connectors + oauth token status
// ---------------------------------------------------------------------------

featuresRoutes.get("/federated", requireAuth, async (c) => {
  return c.json([]);
});

featuresRoutes.get("/federated/oauth-status", requireAuth, async (c) => {
  return c.json([]);
});

featuresRoutes.get("/user-oauth-token/status", requireAuth, async (c) => {
  return c.json([]);
});

// ---------------------------------------------------------------------------
// Incognito availability (chat/api.py)
// ---------------------------------------------------------------------------

featuresRoutes.get("/chat/incognito-availability", requireAuth, async (c) => {
  // Incognito chat requires an ephemeral-model provider; not configured here.
  return c.json(false);
});

// GET /voice/status — VoiceStatusResponse
// (server/manage/voice/user_api.py get_voice_status; consumer
// web/src/lib/voice/hooks.ts). No STT/TTS providers configured in this port.
featuresRoutes.get("/voice/status", requireAuth, async (c) => {
  return c.json({ stt_enabled: false, tts_enabled: false });
});

// GET /enterprise-settings/custom-analytics-script — string | null
// (consumer: web/src/lib/analytics/hooks.ts useCustomAnalyticsScript via
// web/src/lib/swr-keys.ts customAnalyticsScript + the SSR settings fetch in
// web/src/lib/settings/svcSS.ts; the script text is injected into a <script>
// tag by web/src/lib/analytics/shared.tsx). No custom analytics configured
// in this deployment: JSON null.
featuresRoutes.get(
  "/enterprise-settings/custom-analytics-script",
  requireAuth,
  (c) => {
    return c.json(null);
  },
);

// GET /user/projects/session/:sessionId/files — ProjectFile[]
// (consumer: web/src/lib/projects/svc.ts getProjectFilesForSession; the
// frontend treats a non-OK response as an empty list). The projects feature
// is not deployed in this port: every session has no project files.
featuresRoutes.get(
  "/user/projects/session/:sessionId/files",
  requireAuth,
  (c) => {
    return c.json([]);
  },
);
