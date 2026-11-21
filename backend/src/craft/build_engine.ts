/**
 * Onyx Craft (Build mode) engine — the minimal-but-real port of the
 * /build surface upstream serves from the Firecracker sandbox service
 * (onyx/server/features/build/**).
 *
 * Deviations (documented): no microVM sandbox and no opencode agent runtime.
 * Sessions/messages/turns/artifacts persist in Postgres (migration 0012);
 * each turn runs a single-shot LLM build through the same gateway that
 * serves chat: the model writes a plan + one self-contained artifact file
 * (HTML app, markdown document, or code file), which is stored and offered
 * for preview/download. The SSE event vocabulary matches
 * web/src/app/craft/utils/packetTypes.ts (text_chunk, thinking_chunk,
 * tool_call_start/progress, artifact_created, prompt_response,
 * turn_completed, error) so the official Craft UI streams unchanged.
 *
 * Generation is driven by the turn-events endpoint (GET .../turns/{id}/events)
 * rather than background tasks: that keeps the flow correct on serverless
 * (Vercel) where work cannot outlive its request, and locally the same code
 * path runs in-process. Reconnects replay the buffered events.
 */

import { randomUUID as generateId } from "node:crypto";

import { query, queryOne } from "../db/client";
import { getLLMProvider } from "../llm/factory";
import type { LLMProvider } from "../llm/types";
import { getLogger } from "../utils/logger";

const logger = getLogger("craft.build_engine");

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface BuildSessionRow {
  id: string;
  user_id: string;
  name: string | null;
  status: string;
  sharing_scope: string;
  agent_provider: string | null;
  agent_model: string | null;
  deleted: boolean;
  created_at: Date | string;
  last_activity_at: Date | string;
}

interface BuildMessageRow {
  id: string;
  session_id: string;
  turn_index: number;
  type: string;
  content: string | null;
  message_metadata: Record<string, unknown> | null;
  created_at: Date | string;
}

interface BuildTurnRow {
  id: string;
  session_id: string;
  turn_index: number;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  error_detail: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface BuildArtifactRow {
  id: string;
  session_id: string;
  type: string;
  path: string;
  name: string;
  content: string;
  mime_type: string | null;
  size_bytes: number | null;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
}

// ---------------------------------------------------------------------------
// Wire-shape serializers (web/src/app/craft/types/streamingTypes.ts)
// ---------------------------------------------------------------------------

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function toSessionResponse(row: BuildSessionRow): Record<string, unknown> {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    status: "active",
    created_at: iso(row.created_at),
    last_activity_at: iso(row.last_activity_at),
    nextjs_port: null,
    sandbox: {
      id: `sandbox-${row.id.slice(0, 8)}`,
      status: "running",
      container_id: null,
      created_at: iso(row.created_at),
      last_heartbeat: iso(new Date()),
    },
    artifacts: [],
    sharing_scope: row.sharing_scope,
    origin: "interactive",
    agent_provider: row.agent_provider,
    agent_model: row.agent_model,
    skills_stale: false,
  };
}

function toMessageResponse(row: BuildMessageRow): Record<string, unknown> {
  return {
    id: row.id,
    session_id: row.session_id,
    turn_index: row.turn_index,
    type: row.type,
    content: row.content ?? "",
    message_metadata: row.message_metadata,
    created_at: iso(row.created_at),
  };
}

function toArtifactResponse(row: BuildArtifactRow): Record<string, unknown> {
  return {
    id: row.id,
    session_id: row.session_id,
    type: row.type,
    path: row.path,
    name: row.name,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    preview_url: null,
  };
}

// ---------------------------------------------------------------------------
// Session / message / turn / artifact persistence
// ---------------------------------------------------------------------------

export async function createBuildSession(
  userId: string,
  name: string | null,
): Promise<Record<string, unknown>> {
  const row = await queryOne<BuildSessionRow>(
    `INSERT INTO build_session (user_id, name) VALUES ($1, $2)
     RETURNING *`,
    [userId, name],
  );
  if (!row) throw new Error("build_session insert returned no row");
  return toSessionResponse(row);
}

export async function listBuildSessions(
  userId: string,
): Promise<Record<string, unknown>[]> {
  const res = await query<BuildSessionRow>(
    `SELECT * FROM build_session
     WHERE user_id = $1 AND deleted = false
     ORDER BY last_activity_at DESC LIMIT 100`,
    [userId],
  );
  return res.rows.map(toSessionResponse);
}

export async function getBuildSession(
  sessionId: string,
  userId: string,
): Promise<Record<string, unknown> | null> {
  const row = await queryOne<BuildSessionRow>(
    "SELECT * FROM build_session WHERE id = $1 AND user_id = $2 AND deleted = false",
    [sessionId, userId],
  );
  if (!row) return null;
  const artifacts = await query<BuildArtifactRow>(
    "SELECT * FROM build_artifact WHERE session_id = $1 ORDER BY created_at ASC",
    [sessionId],
  );
  return {
    ...toSessionResponse(row),
    session_loaded_in_sandbox: true,
    artifacts: artifacts.rows.map(toArtifactResponse),
  };
}

export async function updateBuildSessionName(
  sessionId: string,
  userId: string,
  name: string | null,
): Promise<Record<string, unknown> | null> {
  const row = await queryOne<BuildSessionRow>(
    `UPDATE build_session SET name = $3, last_activity_at = now()
     WHERE id = $1 AND user_id = $2 AND deleted = false RETURNING *`,
    [sessionId, userId, name],
  );
  return row ? toSessionResponse(row) : null;
}

export async function deleteBuildSession(
  sessionId: string,
  userId: string,
): Promise<void> {
  await query(
    "UPDATE build_session SET deleted = true WHERE id = $1 AND user_id = $2",
    [sessionId, userId],
  );
}

export async function touchBuildSession(sessionId: string): Promise<void> {
  await query(
    "UPDATE build_session SET last_activity_at = now() WHERE id = $1",
    [sessionId],
  );
}

export async function countBuildMessages(sessionId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM build_message WHERE session_id = $1",
    [sessionId],
  );
  return row ? Number(row.count) : 0;
}

export async function appendBuildMessage(
  sessionId: string,
  turnIndex: number,
  type: "user" | "assistant",
  content: string,
): Promise<Record<string, unknown>> {
  const row = await queryOne<BuildMessageRow>(
    `INSERT INTO build_message (id, session_id, turn_index, type, content, message_metadata)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      generateId(),
      sessionId,
      turnIndex,
      type,
      content,
      JSON.stringify({ content: { type: "text", text: content } }),
    ],
  );
  if (!row) throw new Error("build_message insert returned no row");
  return toMessageResponse(row);
}

export async function listBuildMessages(
  sessionId: string,
): Promise<Record<string, unknown>[]> {
  const res = await query<BuildMessageRow>(
    `SELECT * FROM build_message WHERE session_id = $1
     ORDER BY turn_index ASC, created_at ASC`,
    [sessionId],
  );
  return res.rows.map(toMessageResponse);
}

export async function createBuildTurn(
  sessionId: string,
  clientRequestId: string | null,
): Promise<BuildTurnRow> {
  const countRow = await queryOne<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM build_turn WHERE session_id = $1",
    [sessionId],
  );
  const turnIndex = countRow ? Number(countRow.count) : 0;
  const row = await queryOne<BuildTurnRow>(
    `INSERT INTO build_turn (id, session_id, turn_index, status, client_request_id)
     VALUES ($1, $2, $3, 'QUEUED', $4)
     RETURNING *`,
    [generateId(), sessionId, turnIndex, clientRequestId],
  );
  if (!row) throw new Error("build_turn insert returned no row");
  return row;
}

export async function getBuildTurn(
  turnId: string,
): Promise<BuildTurnRow | null> {
  return queryOne<BuildTurnRow>(
    "SELECT * FROM build_turn WHERE id = $1",
    [turnId],
  );
}

export async function getActiveBuildTurn(
  sessionId: string,
): Promise<BuildTurnRow | null> {
  return queryOne<BuildTurnRow>(
    `SELECT * FROM build_turn WHERE session_id = $1
       AND status IN ('QUEUED', 'RUNNING')
     ORDER BY turn_index DESC LIMIT 1`,
    [sessionId],
  );
}

export async function setBuildTurnStatus(
  turnId: string,
  status: BuildTurnRow["status"],
  errorDetail?: string | null,
): Promise<void> {
  await query(
    `UPDATE build_turn SET status = $2, error_detail = $3, updated_at = now()
     WHERE id = $1`,
    [turnId, status, errorDetail ?? null],
  );
}

export async function saveBuildArtifact(
  sessionId: string,
  type: string,
  path: string,
  name: string,
  content: string,
  mime: string,
): Promise<BuildArtifactRow | null> {
  // Same session path -> bump the revision of the existing artifact row.
  const existing = await queryOne<BuildArtifactRow>(
    "SELECT * FROM build_artifact WHERE session_id = $1 AND path = $2 ORDER BY revision DESC LIMIT 1",
    [sessionId, path],
  );
  if (existing) {
    return queryOne<BuildArtifactRow>(
      `UPDATE build_artifact
         SET content = $3, size_bytes = $4, revision = revision + 1, updated_at = now()
       WHERE id = $1 AND session_id = $2
       RETURNING *`,
      [existing.id, sessionId, content, Buffer.byteLength(content, "utf8")],
    );
  }
  return queryOne<BuildArtifactRow>(
    `INSERT INTO build_artifact (id, session_id, type, path, name, content, mime_type, size_bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      generateId(),
      sessionId,
      type,
      path,
      name,
      content,
      mime,
      Buffer.byteLength(content, "utf8"),
    ],
  );
}

export async function listBuildArtifacts(
  sessionId: string,
): Promise<Record<string, unknown>[]> {
  const res = await query<BuildArtifactRow>(
    "SELECT * FROM build_artifact WHERE session_id = $1 ORDER BY created_at ASC",
    [sessionId],
  );
  return res.rows.map(toArtifactResponse);
}

export async function getBuildArtifactContent(
  sessionId: string,
  path: string,
): Promise<BuildArtifactRow | null> {
  return queryOne<BuildArtifactRow>(
    `SELECT * FROM build_artifact WHERE session_id = $1 AND path = $2
     ORDER BY revision DESC LIMIT 1`,
    [sessionId, path],
  );
}

// ---------------------------------------------------------------------------
// Turn generation (LLM build loop) + SSE event fan-out
// ---------------------------------------------------------------------------

export interface CraftEvent {
  type: string;
  payload: Record<string, unknown>;
}

function sseFrameFor(event: CraftEvent): string {
  const body = JSON.stringify({
    ...event.payload,
    type: event.type,
    timestamp: new Date().toISOString(),
  });
  return `event: message\ndata: ${body}\n\n`;
}

interface GenerationState {
  buffer: string[];
  subscribers: Set<(frame: string) => void>;
  done: boolean;
  startedAt: number;
  abort: AbortController;
}

const generations = new Map<string, GenerationState>();

function publish(state: GenerationState, event: CraftEvent): void {
  const frame = sseFrameFor(event);
  state.buffer.push(frame);
  for (const sub of state.subscribers) {
    try {
      sub(frame);
    } catch {
      // subscriber errors never break the generation loop
    }
  }
}

/** Extract the first complete ```lang ... ``` fenced block. */
function extractFencedBlock(
  text: string,
  langs: string[],
): { lang: string; content: string } | null {
  for (const lang of langs) {
    const re = new RegExp("```" + lang + "\\s*\\n([\\s\\S]*?)```", "i");
    const match = text.match(re);
    if (match?.[1] && match[1].trim()) {
      return { lang, content: match[1] };
    }
  }
  return null;
}

/** Derive a display title from HTML <title> or first markdown heading. */
function deriveTitle(text: string, fallback: string): string {
  const htmlTitle = text.match(/<title>([^<]{1,80})<\/title>/i)?.[1];
  if (htmlTitle?.trim()) return htmlTitle.trim();
  const mdHeading = text.match(/^#\s+(.{1,80})$/m)?.[1];
  if (mdHeading?.trim()) return mdHeading.trim();
  const h1 = text.match(/<h1[^>]*>([^<]{1,80})<\/h1>/i)?.[1];
  if (h1?.trim()) return h1.trim();
  return fallback;
}

async function runGeneration(
  turn: BuildTurnRow,
  prompt: string,
  model?: { providerId?: number; provider?: string; modelName?: string } | null,
): Promise<void> {
  const state = generations.get(turn.id);
  if (!state) return;
  try {
    await setBuildTurnStatus(turn.id, "RUNNING");

    const { provider } = await resolveCraftProvider(model);
    const systemPrompt =
      "You are Onyx Craft, an AI builder that creates web applications, " +
      "documents, and presentations.\n" +
      "Respond in TWO parts:\n" +
      "1. A short plan (2-6 sentences) describing what you will build.\n" +
      "2. Exactly ONE fenced code block containing the complete deliverable:\n" +
      "   - For apps/UIs: one ```html block with a complete, self-contained page " +
      "(inline CSS/JS, no external build step, include a <title>).\n" +
      "   - For documents/reports: one ```markdown block with the full content.\n" +
      "   - For code utilities: one ```<language> block with the complete, runnable file.\n" +
      "Keep everything inside the single file; prefer vanilla HTML/CSS/JS for apps.";

    const buffer = new StreamCollector();
    for await (const event of provider.stream(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      { signal: state.abort.signal, maxTokens: 16_000 },
    )) {
      if (event.delta) {
        buffer.append(event.delta);
        publish(state, { type: "text_chunk", payload: { text: event.delta, sessionId: null, parentSessionId: null } });
      }
      if (event.done) break;
      if (event.finish_reason === "stop" || event.finish_reason === "length") break;
    }

    const fullText = buffer.text();
    if (!fullText.trim() && !state.abort.signal.aborted) {
      throw new Error("The model returned an empty response");
    }

    // Materialize the artifact from the fenced block (or whole text).
    const html = extractFencedBlock(fullText, ["html"]);
    const markdown = html ? null : extractFencedBlock(fullText, ["markdown", "md"]);
    let artifactType = "other";
    let artifactPath = "outputs/output.txt";
    let artifactName = "Output";
    let artifactMime = "text/plain";
    let artifactContent = "";
    if (html) {
      artifactType = "web_app";
      artifactPath = "outputs/index.html";
      artifactName = deriveTitle(html.content, "Web App");
      artifactMime = "text/html";
      artifactContent = html.content;
    } else if (markdown) {
      artifactType = "markdown";
      artifactPath = "outputs/document.md";
      artifactName = deriveTitle(markdown.content, "Document");
      artifactMime = "text/markdown";
      artifactContent = markdown.content;
    } else {
      // No fenced block: treat the whole text as a markdown document.
      artifactType = "markdown";
      artifactPath = "outputs/document.md";
      artifactName = deriveTitle(fullText, "Document");
      artifactMime = "text/markdown";
      artifactContent = fullText.replace(/^```[a-z]*\s*\n?/, "").replace(/```\s*$/, "");
    }

    // write tool call visualization (packetTypes.ts tool_call_start/progress)
    const toolCallId = `write-${turn.turn_index}`;
    publish(state, {
      type: "tool_call_start",
      payload: {
        toolCallId,
        tool_name: "write",
        kind: "edit",
        title: "Writing file",
        description: artifactPath,
        command: "",
        filePath: artifactPath,
        sessionId: null,
        parentSessionId: null,
        subagentSessionId: null,
        subagentType: null,
        skillName: null,
      },
    });
    const savedArtifact = await saveBuildArtifact(
      turn.session_id,
      artifactType,
      artifactPath,
      artifactName,
      artifactContent,
      artifactMime,
    );
    publish(state, {
      type: "tool_call_progress",
      payload: {
        toolCallId,
        tool_name: "write",
        kind: "edit",
        status: "completed",
        title: `Wrote ${artifactPath}`,
        description: artifactPath,
        command: "",
        rawOutput: "",
        filePath: artifactPath,
        isNewFile: true,
        oldContent: "",
        newContent: artifactContent,
        todos: [],
        taskOutput: null,
        sessionId: null,
        parentSessionId: null,
        subagentSessionId: null,
        subagentType: null,
        skillName: null,
      },
    });

    if (savedArtifact) {
      publish(state, {
        type: "artifact_created",
        payload: {
          artifact: {
            id: savedArtifact.id,
            type: savedArtifact.type,
            name: savedArtifact.name,
            path: savedArtifact.path,
            preview_url: null,
            mime_type: savedArtifact.mime_type,
            size_bytes: savedArtifact.size_bytes,
          },
        },
      });
    }

    // Persist the assistant message + settle the turn.
    await appendBuildMessage(turn.session_id, turn.turn_index, "assistant", fullText);
    await touchBuildSession(turn.session_id);
    await setBuildTurnStatus(turn.id, "SUCCEEDED");
    publish(state, { type: "prompt_response", payload: {} });
    publish(state, {
      type: "turn_completed",
      payload: {
        turn: {
          turn_id: turn.id,
          session_id: turn.session_id,
          status: "SUCCEEDED",
          turn_index: turn.turn_index,
          error_detail: null,
        },
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cancelled = state.abort.signal.aborted;
    logger.warning("craft turn failed", { turn: turn.id, error: message, cancelled });
    try {
      await setBuildTurnStatus(turn.id, cancelled ? "CANCELLED" : "FAILED", message);
    } catch (persistErr) {
      logger.warning("craft turn status persist failed", { error: String(persistErr) });
    }
    if (cancelled) {
      publish(state, {
        type: "turn_completed",
        payload: {
          turn: {
            turn_id: turn.id,
            session_id: turn.session_id,
            status: "CANCELLED",
            turn_index: turn.turn_index,
            error_detail: null,
          },
        },
      });
    } else {
      publish(state, { type: "error", payload: { message } });
      publish(state, {
        type: "turn_completed",
        payload: {
          turn: {
            turn_id: turn.id,
            session_id: turn.session_id,
            status: "FAILED",
            turn_index: turn.turn_index,
            error_detail: message,
          },
        },
      });
    }
  } finally {
    state.done = true;
    setTimeout(() => generations.delete(turn.id), 10 * 60 * 1000);
  }
}

async function resolveCraftProvider(
  model?: { providerId?: number; provider?: string; modelName?: string } | null,
): Promise<{ provider: LLMProvider }> {
  let providerId: string | undefined;
  let modelName: string | undefined;
  if (model?.providerId) {
    const row = await queryOne<{ provider: string; name: string | null; default_model_name: string | null }>(
      "SELECT provider, name, default_model_name FROM llm_provider WHERE id = $1",
      [model.providerId],
    );
    if (row) {
      providerId = row.provider;
      modelName = model.modelName ?? row.default_model_name ?? undefined;
    }
  } else if (model?.modelName) {
    modelName = model.modelName;
    providerId = model.provider;
  }
  const provider = await getLLMProvider(providerId, modelName);
  return { provider };
}

/** Tiny text collector (same semantics as chat StreamBuffer for plain text). */
class StreamCollector {
  private parts: string[] = [];
  append(delta: string): void {
    this.parts.push(delta);
  }
  text(): string {
    return this.parts.join("");
  }
}

/**
 * Ensure a QUEUED/RUNNING turn has a live generation; returns the generation
 * state so the events endpoint can subscribe/replay. Safe to call on every
 * reconnect — a running generation is never restarted.
 */
export function ensureGeneration(
  turn: BuildTurnRow,
  prompt: string | null,
  model?: { providerId?: number; provider?: string; modelName?: string } | null,
): GenerationState {
  let state = generations.get(turn.id);
  if (!state) {
    state = {
      buffer: [],
      subscribers: new Set(),
      done: false,
      startedAt: Date.now(),
      abort: new AbortController(),
    };
    generations.set(turn.id, state);
    if (prompt !== null) {
      void runGeneration(turn, prompt, model);
    } else {
      // Reconnect to a turn whose prompt is unknown (e.g. after a process
      // restart): fail the turn cleanly instead of hanging forever.
      state.done = true;
      void setBuildTurnStatus(turn.id, "FAILED", "Generation was interrupted");
    }
  }
  return state;
}

/** Interrupt endpoint: abort the live generation (no-op when finished). */
export function interruptTurn(turnId: string): boolean {
  const state = generations.get(turnId);
  if (state && !state.done) {
    state.abort.abort();
    return true;
  }
  return false;
}

export function subscribeGeneration(
  state: GenerationState,
  onFrame: (frame: string) => void,
): () => void {
  state.subscribers.add(onFrame);
  return () => state.subscribers.delete(onFrame);
}

export function replayGeneration(state: GenerationState): string {
  return state.buffer.join("");
}

export function isGenerationDone(state: GenerationState): boolean {
  return state.done;
}
