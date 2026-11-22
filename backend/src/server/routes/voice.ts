/**
 * Voice routes — TTS synthesis + user voice settings.
 *
 * Port surface (v5.1.3 web/src/lib/streamingTTS.ts + voice recorder):
 *   GET   /voice/status            -> {stt_enabled, tts_enabled}
 *   GET   /voice/settings          -> user voice preferences
 *   PATCH /voice/settings          -> update {auto_send, auto_playback, playback_speed}
 *   POST  /voice/synthesize        -> audio/wav bytes (z-ai TTS; upstream serves
 *                                     mp3 — the frontend sniffs the container so
 *                                     WAV plays via <audio>; the frontend fork
 *                                     checks Content-Type before MediaSource)
 *   POST  /voice/synthesize/stream -> same payload, buffered WAV response
 *   POST  /voice/ws-token          -> {token} for the STT websocket (STT is
 *                                     not provisioned in this port; the token
 *                                     is returned but no WS endpoint listens)
 */

import { Hono } from "hono";
import { z } from "zod";
import { getAuth, requireAuth } from "../../auth/middleware";
import { getZaiClient } from "../../llm/providers/zai";
import { query, queryOne } from "../../db/client";
import { getLogger } from "../../utils/logger";

const logger = getLogger("server.routes.voice");

export const voiceRoutes = new Hono();

// ---------------------------------------------------------------------------
// Status (server/manage/voice/user_api.py get_voice_status)
// ---------------------------------------------------------------------------

voiceRoutes.get("/voice/status", requireAuth, (c) => {
  // TTS is provisioned through the z-ai audio surface; STT websocket is not.
  return c.json({ stt_enabled: false, tts_enabled: true });
});

// ---------------------------------------------------------------------------
// Voice settings (user preferences)
// ---------------------------------------------------------------------------

const voiceSettingsSchema = z.object({
  auto_send: z.boolean().optional(),
  auto_playback: z.boolean().optional(),
  playback_speed: z.number().min(0.25).max(4).optional(),
});

voiceRoutes.get("/voice/settings", requireAuth, async (c) => {
  const auth = getAuth(c);
  if (!auth) return c.json({ detail: "Unauthorized" }, 401);
  const row = await queryOne<{ preferences: Record<string, unknown> | null }>(
    `SELECT preferences FROM onyx_user WHERE id = $1`,
    [auth.user.id],
  );
  const prefs = row?.preferences ?? {};
  return c.json({
    auto_send: prefs.voice_auto_send ?? false,
    auto_playback: prefs.voice_auto_playback ?? false,
    playback_speed: prefs.voice_playback_speed ?? 1.0,
  });
});

voiceRoutes.patch("/voice/settings", requireAuth, async (c) => {
  const auth = getAuth(c);
  if (!auth) return c.json({ detail: "Unauthorized" }, 401);
  const user = auth.user;
  let body: z.infer<typeof voiceSettingsSchema>;
  try {
    body = voiceSettingsSchema.parse(await c.req.json());
  } catch (err) {
    return c.json(
      {
        detail: `Invalid voice settings: ${err instanceof Error ? err.message : String(err)}`,
      },
      400,
    );
  }

  // Merge into the user's stored preferences JSONB (same convention as the
  // other preference writes — the whole dict is persisted).
  const row = await queryOne<{ preferences: Record<string, unknown> | null }>(
    `SELECT preferences FROM onyx_user WHERE id = $1`,
    [user.id],
  );
  const prefs = { ...(row?.preferences ?? {}) };
  if (body.auto_send !== undefined) prefs.voice_auto_send = body.auto_send;
  if (body.auto_playback !== undefined)
    prefs.voice_auto_playback = body.auto_playback;
  if (body.playback_speed !== undefined)
    prefs.voice_playback_speed = body.playback_speed;
  await query(`UPDATE onyx_user SET preferences = $2::jsonb WHERE id = $1`, [
    user.id,
    JSON.stringify(prefs),
  ]);
  return c.json({
    auto_send: prefs.voice_auto_send ?? false,
    auto_playback: prefs.voice_auto_playback ?? false,
    playback_speed: prefs.voice_playback_speed ?? 1.0,
  });
});

// ---------------------------------------------------------------------------
// TTS synthesis (z-ai audio.tts -> WAV)
// ---------------------------------------------------------------------------

const synthesizeSchema = z.object({
  text: z.string().min(1).max(40_000),
  voice: z.string().optional(),
  speed: z.number().min(0.25).max(4).optional(),
});

/** Map frontend voice names (upstream voices) onto z-ai voices. */
function resolveVoice(voice?: string): string {
  const zaiVoices = new Set([
    "tongtong",
    "chuichui",
    "xiaochen",
    "jam",
    "kazi",
    "douji",
    "luodo",
  ]);
  if (voice && zaiVoices.has(voice)) return voice;
  return "tongtong";
}

async function synthesizeWav(
  text: string,
  voice?: string,
  speed?: number,
): Promise<ArrayBuffer> {
  const zai = await getZaiClient();
  const response = await zai.audio.tts.create({
    input: text,
    voice: resolveVoice(voice),
    speed: speed ?? 1.0,
    response_format: "wav",
    stream: false,
  });
  return await response.arrayBuffer();
}

voiceRoutes.post("/voice/synthesize", requireAuth, async (c) => {
  let body: z.infer<typeof synthesizeSchema>;
  try {
    body = synthesizeSchema.parse(await c.req.json());
  } catch (err) {
    return c.json(
      {
        detail: `Invalid synthesize request: ${err instanceof Error ? err.message : String(err)}`,
      },
      400,
    );
  }
  try {
    const wav = await synthesizeWav(body.text, body.voice, body.speed);
    return new Response(wav, {
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(wav.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    logger.warning("tts synthesis failed", { error: String(err) });
    return c.json({ detail: "TTS synthesis failed" }, 502);
  }
});

// The frontend's voice mode calls the /stream variant expecting mp3 chunks;
// this port serves the buffered WAV with the same contract as the non-stream
// endpoint (frontend fork sniffs the Content-Type and buffers playback).
voiceRoutes.post("/voice/synthesize/stream", requireAuth, async (c) => {
  let body: z.infer<typeof synthesizeSchema>;
  try {
    body = synthesizeSchema.parse(await c.req.json());
  } catch (err) {
    return c.json(
      {
        detail: `Invalid synthesize request: ${err instanceof Error ? err.message : String(err)}`,
      },
      400,
    );
  }
  try {
    const wav = await synthesizeWav(body.text, body.voice, body.speed);
    return new Response(wav, {
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(wav.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    logger.warning("tts synthesis failed", { error: String(err) });
    return c.json({ detail: "TTS synthesis failed" }, 502);
  }
});

// ---------------------------------------------------------------------------
// STT websocket token (voice recorder) — STT is not provisioned; the token
// response satisfies the auth handshake but no WS endpoint listens.
// ---------------------------------------------------------------------------

voiceRoutes.post("/voice/ws-token", requireAuth, (c) => {
  return c.json({ token: "stt-unavailable" });
});

// ---------------------------------------------------------------------------
// Admin voice providers (admin voice settings page)
// ---------------------------------------------------------------------------

voiceRoutes.get("/admin/voice/providers", requireAuth, (c) => {
  // VoiceProvidersResponse — the z-ai TTS surface is built-in, not a
  // configured provider row.
  return c.json({
    tts_provider: null,
    stt_provider: null,
    tts_providers: [],
    stt_providers: [],
  });
});
