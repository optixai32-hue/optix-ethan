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
import { z } from "zod";
import { query } from "../../db/client";
import { requireAuth } from "../../auth/middleware";
import {
  OPENAI_API_BASE,
  OPENAI_API_KEY,
} from "../../configs/constants";

/** TTS gateway model + default voice (ONYX_TTS_MODEL env override). */
const TTS_MODEL =
  process.env.ONYX_TTS_MODEL?.trim() || "openai/gpt-4o-mini-tts";
const TTS_DEFAULT_VOICE = process.env.ONYX_TTS_VOICE?.trim() || "alloy";

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
  // get_mcp_servers_for_user — no MCP server rows in this port yet.
  return c.json({ mcp_servers: [] });
});

featuresRoutes.get("/mcp/servers/persona/:assistantId", requireAuth, async (c) => {
  // get_mcp_servers_for_assistant — persona-scoped listing; no servers yet.
  return c.json({
    assistant_id: c.req.param("assistantId"),
    mcp_servers: [],
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
// Voice (server/manage/voice/user_api.py + voice synthesis). TTS goes through
// the OpenAI-compatible gateway (/audio/speech) when configured — the same
// Kilo gateway that serves chat, so the toolbar read-aloud button matches
// cloud behavior. Without gateway credentials the status stays disabled.
// ---------------------------------------------------------------------------

featuresRoutes.get("/voice/status", requireAuth, async (c) => {
  const ttsEnabled = Boolean(OPENAI_API_BASE && OPENAI_API_KEY);
  return c.json({
    stt_enabled: false,
    tts_enabled: ttsEnabled,
    tts_model: TTS_MODEL,
    default_voice: TTS_DEFAULT_VOICE,
  });
});

const synthesizeSchema = z.object({
  text: z.string().min(1),
  voice: z.string().optional(),
  speed: z.number().optional(),
});

/** Shared synthesis proxy: POST {text, voice?, speed?} -> audio/mpeg stream. */
async function synthesizeSpeech(c: any): Promise<Response> {
  if (!OPENAI_API_BASE || !OPENAI_API_KEY) {
    return c.json(
      { detail: "No TTS provider configured (set KILO_GATEWAY_* / ONYX_OPENAI_*)" },
      501,
    );
  }
  let body: z.infer<typeof synthesizeSchema>;
  try {
    body = synthesizeSchema.parse(await c.req.json());
  } catch (err) {
    return c.json(
      { detail: `Invalid synthesize request: ${err instanceof Error ? err.message : String(err)}` },
      400,
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const upstream = await fetch(`${OPENAI_API_BASE.replace(/\/$/, "")}/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        input: body.text.slice(0, 8000),
        voice: body.voice || TTS_DEFAULT_VOICE,
        ...(body.speed && body.speed > 0 ? { speed: body.speed } : {}),
        response_format: "mp3",
      }),
      signal: controller.signal,
    });
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      return c.json(
        { detail: `TTS provider error (${upstream.status}): ${detail.slice(0, 200)}` },
        502,
      );
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    return c.json({ detail: `TTS synthesis failed: ${String(err)}` }, 502);
  } finally {
    clearTimeout(timeout);
  }
}

featuresRoutes.post("/voice/synthesize", requireAuth, (c) => synthesizeSpeech(c));
// The streaming variant used by voice mode — same non-chunked gateway call.
featuresRoutes.post("/voice/synthesize/stream", requireAuth, (c) => synthesizeSpeech(c));

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
