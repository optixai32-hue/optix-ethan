/**
 * Craft (Build mode) routes — the /build surface the official Onyx Craft UI
 * calls (web/src/app/craft/services/apiServices.ts + useBuildStreaming.ts).
 * Engine lives in craft/build_engine.ts (Postgres-backed, no sandbox).
 *
 *   POST   /build/sessions                          create session
 *   GET    /build/sessions                          session history
 *   GET    /build/sessions/:id                      session detail
 *   PUT    /build/sessions/:id/name                 rename
 *   PATCH  /build/sessions/:id/public               sharing scope
 *   DELETE /build/sessions/:id                      delete (soft)
 *   POST   /build/sessions/:id/restore              restore (no-op reactivation)
 *   GET    /build/sessions/:id/pre-provisioned-check  empty-session probe
 *   GET    /build/sessions/:id/sandbox-status       sandbox status
 *   POST   /build/sessions/:id/send-message         create turn (persists user msg)
 *   GET    /build/sessions/:id/turns/:turnId/events  SSE event stream (drives gen)
 *   GET    /build/sessions/:id/turns/active         active turn
 *   GET    /build/sessions/:id/turns/:turnId        known turn
 *   POST   /build/sessions/:id/interrupt            interrupt active turn
 *   GET    /build/sessions/:id/messages             message list
 *   GET    /build/sessions/:id/artifacts            artifact list
 *   GET    /build/sessions/:id/artifacts/:path      artifact content (preview dl)
 *   GET    /build/sessions/:id/files                directory listing
 *   GET    /build/sessions/:id/outputs              output inventory
 *   GET    /build/sessions/:id/output-cards         output cards
 *   PATCH  /build/sessions/:id/output-cards/viewed  mark viewed
 *   GET    /build/sessions/:id/webapp-info          webapp info (no live webapp)
 *   POST   /build/sessions/:id/skills/reload        skills state
 *   GET    /build/sessions/:id/scheduled-run-context  scheduled run (none)
 *   GET    /build/skills, /build/scheduled-tasks    empty catalogs
 */

import { Hono } from "hono";
import { z } from "zod";
import { query, queryOne } from "../../db/client";
import { requireAuth, getAuth } from "../../auth/middleware";
import { NotFoundError, InvalidRequestError } from "../../utils/errors";
import { getLogger } from "../../utils/logger";
import {
  appendBuildMessage,
  countBuildMessages,
  createBuildSession,
  createBuildTurn,
  deleteBuildSession,
  ensureGeneration,
  getActiveBuildTurn,
  getBuildArtifactContent,
  getBuildSession,
  getBuildTurn,
  interruptTurn,
  isGenerationDone,
  listBuildArtifacts,
  listBuildMessages,
  listBuildSessions,
  replayGeneration,
  setBuildTurnStatus,
  subscribeGeneration,
  touchBuildSession,
  updateBuildSessionName,
} from "../../craft/build_engine";

const logger = getLogger("routes.build");

export const buildRoutes = new Hono();

// ---------------------------------------------------------------------------
// Auth + ownership helpers
// ---------------------------------------------------------------------------

async function requireOwnedBuildSession(sessionId: string, userId: string) {
  const session = await getBuildSession(sessionId, userId);
  if (!session) {
    throw new NotFoundError("Build session");
  }
  return session;
}

function uuidOrThrow(raw: string): string {
  if (!/^[0-9a-fA-F-]{36}$/.test(raw)) {
    throw new InvalidRequestError("Invalid session id format");
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const createSessionSchema = z.object({
  name: z.string().nullish(),
  origin: z.string().nullish(),
});

buildRoutes.post("/sessions", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  let body: z.infer<typeof createSessionSchema> = {};
  try {
    body = createSessionSchema.parse(await c.req.json().catch(() => ({})));
  } catch (err) {
    throw new InvalidRequestError(
      `Invalid create session request: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return c.json(await createBuildSession(userId, body.name ?? null), 201);
});

buildRoutes.get("/sessions", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  const sessions = await listBuildSessions(userId);
  return c.json({ sessions });
});

buildRoutes.get("/sessions/:sessionId", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  const sessionId = uuidOrThrow(c.req.param("sessionId"));
  const session = await requireOwnedBuildSession(sessionId, userId);
  return c.json(session);
});

buildRoutes.put("/sessions/:sessionId/name", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  const sessionId = uuidOrThrow(c.req.param("sessionId"));
  await requireOwnedBuildSession(sessionId, userId);
  const body = z
    .object({ name: z.string().nullish() })
    .parse(await c.req.json().catch(() => ({})));
  const session = await updateBuildSessionName(sessionId, userId, body.name ?? null);
  if (!session) throw new NotFoundError("Build session");
  return c.json(session);
});

buildRoutes.patch("/sessions/:sessionId/public", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  const sessionId = uuidOrThrow(c.req.param("sessionId"));
  await requireOwnedBuildSession(sessionId, userId);
  const body = z
    .object({ sharing_scope: z.enum(["private", "organization", "public"]).nullish() })
    .parse(await c.req.json().catch(() => ({})));
  await queryOne(
    "UPDATE build_session SET sharing_scope = $3 WHERE id = $1 AND user_id = $2",
    [sessionId, userId, body.sharing_scope ?? "private"],
  );
  return c.json({
    session_id: sessionId,
    sharing_scope: body.sharing_scope ?? "private",
  });
});

buildRoutes.delete("/sessions/:sessionId", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  const sessionId = uuidOrThrow(c.req.param("sessionId"));
  await requireOwnedBuildSession(sessionId, userId);
  await deleteBuildSession(sessionId, userId);
  return c.json({ success: true });
});

buildRoutes.post("/sessions/:sessionId/restore", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  const sessionId = uuidOrThrow(c.req.param("sessionId"));
  await requireOwnedBuildSession(sessionId, userId);
  return c.json(await getBuildSession(sessionId, userId));
});

buildRoutes.get("/sessions/:sessionId/pre-provisioned-check", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  const sessionId = c.req.param("sessionId");
  // A pre-provisioned session is "valid" while it has no messages.
  try {
    await requireOwnedBuildSession(uuidOrThrow(sessionId), userId);
    const count = await countBuildMessages(uuidOrThrow(sessionId));
    return c.json({ valid: count === 0, session_id: count === 0 ? sessionId : null });
  } catch {
    return c.json({ valid: false, session_id: null });
  }
});

buildRoutes.get("/sessions/:sessionId/sandbox-status", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  const sessionId = uuidOrThrow(c.req.param("sessionId"));
  await requireOwnedBuildSession(sessionId, userId);
  // No microVM sandbox in this port: the session is always "running" against
  // the Postgres-backed engine.
  return c.json({ status: "running" });
});

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

const sendMessageSchema = z.object({
  content: z.string().min(1),
  client_request_id: z.string().nullish(),
  attachments: z
    .array(
      z.object({
        name: z.string(),
        path: z.string(),
        mime_type: z.string(),
      }),
    )
    .nullish(),
  provider: z.string().nullish(),
  provider_id: z.number().nullish(),
  model: z.string().nullish(),
});

buildRoutes.post("/sessions/:sessionId/send-message", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  const sessionId = uuidOrThrow(c.req.param("sessionId"));
  await requireOwnedBuildSession(sessionId, userId);
  let body: z.infer<typeof sendMessageSchema>;
  try {
    body = sendMessageSchema.parse(await c.req.json());
  } catch (err) {
    throw new InvalidRequestError(
      `Invalid send-message request: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const turn = await createBuildTurn(sessionId, body.client_request_id ?? null);
  // The accepted turn guarantees the first message is persisted.
  await appendBuildMessage(sessionId, turn.turn_index, "user", body.content);
  await touchBuildSession(sessionId);

  // Keep the session name auto-derived from the first prompt (nameBuildSession
  // on the frontend relies on the session becoming named).
  await queryOne(
    `UPDATE build_session
       SET name = COALESCE(name, left($2, 60)), last_activity_at = now()
     WHERE id = $1`,
    [sessionId, body.content],
  );

  return c.json({
    turn_id: turn.id,
    session_id: sessionId,
    status: "QUEUED",
    turn_index: turn.turn_index,
    error_detail: null,
  });
});

buildRoutes.get("/sessions/:sessionId/turns/active", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  const sessionId = uuidOrThrow(c.req.param("sessionId"));
  await requireOwnedBuildSession(sessionId, userId);
  const turn = await getActiveBuildTurn(sessionId);
  return c.json(
    turn
      ? {
          turn_id: turn.id,
          session_id: turn.session_id,
          status: turn.status,
          turn_index: turn.turn_index,
          error_detail: turn.error_detail,
        }
      : null,
  );
});

buildRoutes.get("/sessions/:sessionId/turns/:turnId", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  const sessionId = uuidOrThrow(c.req.param("sessionId"));
  await requireOwnedBuildSession(sessionId, userId);
  const turn = await getBuildTurn(c.req.param("turnId"));
  if (!turn || turn.session_id !== sessionId) {
    throw new NotFoundError("Turn");
  }
  return c.json({
    turn_id: turn.id,
    session_id: turn.session_id,
    status: turn.status,
    turn_index: turn.turn_index,
    error_detail: turn.error_detail,
  });
});

buildRoutes.get("/sessions/:sessionId/turns/:turnId/events", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  const sessionId = uuidOrThrow(c.req.param("sessionId"));
  await requireOwnedBuildSession(sessionId, userId);
  const turn = await getBuildTurn(c.req.param("turnId"));
  if (!turn || turn.session_id !== sessionId) {
    throw new NotFoundError("Turn");
  }

  // Recover the turn prompt from the persisted user message (generation is
  // driven by the events endpoint, so reconnects after process restarts
  // resume correctly — a turn that never started is failed cleanly).
  const promptRow = await queryOne<{ content: string | null }>(
    `SELECT content FROM build_message
     WHERE session_id = $1 AND turn_index = $2 AND type = 'user'
     ORDER BY created_at ASC LIMIT 1`,
    [sessionId, turn.turn_index],
  );
  const modelRow = await queryOne<{ agent_provider: string | null; agent_model: string | null }>(
    "SELECT agent_provider, agent_model FROM build_session WHERE id = $1",
    [sessionId],
  );
  const state = ensureGeneration(
    turn,
    promptRow?.content ?? null,
    modelRow?.agent_model
      ? { provider: modelRow.agent_provider ?? undefined, modelName: modelRow.agent_model.split("/").slice(1).join("/") || modelRow.agent_model }
      : null,
  );

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const push = (frame: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          closed = true;
        }
      };
      // Replay everything already emitted (reconnect support).
      push(replayGeneration(state));
      if (isGenerationDone(state)) {
        closed = true;
        controller.close();
        return;
      }
      const unsubscribe = subscribeGeneration(state, (frame) => {
        push(frame);
      });
      const finish = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      // Poll for completion: turn_completed frames are pushed live, but the
      // generation may finish between replay and subscribe.
      const poll = setInterval(() => {
        if (isGenerationDone(state)) {
          clearInterval(poll);
          finish();
        }
      }, 250);
      // Hard cap: 10 minutes (matches the chat turn wall-clock budget).
      setTimeout(() => {
        clearInterval(poll);
        finish();
      }, 10 * 60 * 1000);
      // Abort when the client disconnects (Hono/Node wires request signals).
      try {
        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(poll);
          finish();
        });
      } catch {
        // signal unsupported — polling finish covers it
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

buildRoutes.post("/sessions/:sessionId/interrupt", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  const sessionId = uuidOrThrow(c.req.param("sessionId"));
  await requireOwnedBuildSession(sessionId, userId);
  const body = z
    .object({ turn_id: z.string().nullish() })
    .parse(await c.req.json().catch(() => ({})));
  const turn = body.turn_id
    ? await getBuildTurn(body.turn_id)
    : await getActiveBuildTurn(sessionId);
  if (!turn || turn.session_id !== sessionId) {
    return c.json({ interrupted: false });
  }
  const interrupted = interruptTurn(turn.id);
  if (!interrupted && (turn.status === "QUEUED" || turn.status === "RUNNING")) {
    await setBuildTurnStatus(turn.id, "CANCELLED");
  }
  return c.json({ interrupted: true });
});

// ---------------------------------------------------------------------------
// Messages / artifacts / files / outputs
// ---------------------------------------------------------------------------

buildRoutes.get("/sessions/:sessionId/messages", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  const sessionId = uuidOrThrow(c.req.param("sessionId"));
  await requireOwnedBuildSession(sessionId, userId);
  const messages = await listBuildMessages(sessionId);
  return c.json({ messages });
});

buildRoutes.get("/sessions/:sessionId/artifacts", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  const sessionId = uuidOrThrow(c.req.param("sessionId"));
  await requireOwnedBuildSession(sessionId, userId);
  return c.json(await listBuildArtifacts(sessionId));
});

buildRoutes.get("/sessions/:sessionId/artifacts/:path{.+}", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  const sessionId = uuidOrThrow(c.req.param("sessionId"));
  await requireOwnedBuildSession(sessionId, userId);
  const path = c.req.param("path");
  const artifact = await getBuildArtifactContent(sessionId, path);
  if (!artifact) {
    throw new NotFoundError("Artifact");
  }
  return new Response(artifact.content, {
    status: 200,
    headers: {
      "Content-Type": artifact.mime_type ?? "text/plain",
      "Content-Disposition": `inline; filename="${encodeURIComponent(artifact.name)}"`,
      "Cache-Control": "no-cache",
    },
  });
});

buildRoutes.get("/sessions/:sessionId/files", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  const sessionId = uuidOrThrow(c.req.param("sessionId"));
  await requireOwnedBuildSession(sessionId, userId);
  // Flat engine: files live under outputs/ — surface them as entries.
  const artifacts = await listBuildArtifacts(sessionId);
  return c.json({
    path: c.req.query("path") ?? "",
    entries: artifacts.map((a) => ({
      name: (a as { path: string }).path.split("/").pop() ?? "",
      path: (a as { path: string }).path,
      is_directory: false,
      size: 0,
    })),
  });
});

buildRoutes.get("/sessions/:sessionId/outputs", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  const sessionId = uuidOrThrow(c.req.param("sessionId"));
  await requireOwnedBuildSession(sessionId, userId);
  const artifacts = await listBuildArtifacts(sessionId);
  return c.json({
    files: artifacts.map((a) => ({
      path: (a as { path: string }).path,
      revision: (a as { revision?: number }).revision ?? 1,
      size: (a as { size_bytes?: number | null }).size_bytes ?? 0,
    })),
    complete: true,
  });
});

buildRoutes.get("/sessions/:sessionId/output-cards", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  const sessionId = uuidOrThrow(c.req.param("sessionId"));
  await requireOwnedBuildSession(sessionId, userId);
  const artifacts = await listBuildArtifacts(sessionId);
  return c.json({
    cards: artifacts.map((a, index) => ({
      id: (a as { id: string }).id,
      kind: (a as { type: string }).type === "web_app" ? "app" : "file",
      path: (a as { path: string }).path,
      name: (a as { name: string }).name,
      turn_index: index,
      revision: (a as { revision?: number }).revision ?? 1,
      size_bytes: (a as { size_bytes?: number | null }).size_bytes ?? null,
      deleted: false,
      viewed_revision: null,
    })),
  });
});

buildRoutes.patch("/sessions/:sessionId/output-cards/viewed", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  const sessionId = uuidOrThrow(c.req.param("sessionId"));
  await requireOwnedBuildSession(sessionId, userId);
  // View-state is UI-local in this port (no persistence table).
  return c.json({ cards: [] });
});

buildRoutes.patch("/sessions/:sessionId/output-cards/:cardId/viewed", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  const sessionId = uuidOrThrow(c.req.param("sessionId"));
  await requireOwnedBuildSession(sessionId, userId);
  return c.json({ id: c.req.param("cardId"), viewed_revision: 1 });
});

buildRoutes.get("/sessions/:sessionId/webapp-info", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  const sessionId = uuidOrThrow(c.req.param("sessionId"));
  await requireOwnedBuildSession(sessionId, userId);
  // No live webapp server (no sandbox runtime). When the latest artifact is a
  // web_app, serve its static HTML through the webapp-preview endpoint so the
  // Apps panel iframe renders it — the same UX as a cloud webapp preview.
  const artifacts = await listBuildArtifacts(sessionId);
  const webApp = [...artifacts]
    .reverse()
    .find((a) => (a as { type: string }).type === "web_app");
  if (webApp) {
    return c.json({
      has_webapp: true,
      webapp_url: `/api/build/sessions/${sessionId}/webapp-preview`,
      status: "running",
      ready: true,
      sharing_scope: "private",
    });
  }
  return c.json({
    has_webapp: false,
    webapp_url: null,
    status: "not_applicable",
    ready: false,
    sharing_scope: "private",
  });
});

/** Static webapp preview: the latest web_app artifact rendered as HTML. */
buildRoutes.get("/sessions/:sessionId/webapp-preview", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  const sessionId = uuidOrThrow(c.req.param("sessionId"));
  await requireOwnedBuildSession(sessionId, userId);
  const artifacts = await listBuildArtifacts(sessionId);
  const webApp = [...artifacts]
    .reverse()
    .find((a) => (a as { type: string }).type === "web_app");
  if (!webApp) {
    throw new NotFoundError("Webapp");
  }
  const content = await getBuildArtifactContent(sessionId, (webApp as { path: string }).path);
  return new Response(content?.content ?? "", {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      // The preview iframe is sandboxed by the frontend; allow scripts so the
      // generated app actually runs.
      "X-Frame-Options": "SAMEORIGIN",
    },
  });
});

buildRoutes.post("/sessions/:sessionId/skills/reload", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  const sessionId = uuidOrThrow(c.req.param("sessionId"));
  await requireOwnedBuildSession(sessionId, userId);
  return c.json({ skills_stale: false });
});

buildRoutes.get("/sessions/:sessionId/scheduled-run-context", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  const sessionId = uuidOrThrow(c.req.param("sessionId"));
  await requireOwnedBuildSession(sessionId, userId);
  return c.json(null);
});

buildRoutes.get("/sessions/:sessionId/scheduled-run-events", requireAuth, async (c) => {
  const userId = getAuth(c)!.user.id;
  const sessionId = uuidOrThrow(c.req.param("sessionId"));
  await requireOwnedBuildSession(sessionId, userId);
  return c.json({ events: [] });
});

// ---------------------------------------------------------------------------
// Catalogs (empty in this port)
// ---------------------------------------------------------------------------

buildRoutes.get("/skills", requireAuth, (c) => c.json({ skills: [] }));
buildRoutes.get("/scheduled-tasks", requireAuth, (c) => c.json({ tasks: [] }));
buildRoutes.get("/user-library", requireAuth, (c) => c.json({ items: [] }));
buildRoutes.get("/admin/apps", requireAuth, (c) => c.json([]));
buildRoutes.get("/apps", requireAuth, (c) => c.json([]));
