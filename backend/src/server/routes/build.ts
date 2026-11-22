/**
 * Onyx Craft ("Build") routes — the /build surface consumed by the v5.1.3
 * craft frontend at /craft/v1. The frontend proxies /api/build/* into this
 * mount (BUILD_API_BASE = "/api/build", web/src/app/craft/v1/constants.ts;
 * the Next.js proxy strips the /api prefix, so routes here are relative to
 * the /build mount added in server/app.ts).
 *
 * Wire-format sources verified before writing (task 10-craft):
 *   - web/src/app/craft/services/apiServices.ts — every REST shape:
 *     GET /sessions -> {sessions: [...]}; POST /sessions, POST /restore and
 *     GET /sessions/:id -> ApiDetailedSessionResponse; PUT /sessions/:id/name
 *     -> ApiSessionResponse (PUT, not POST — renameBuildSession); DELETE
 *     /sessions/:id; PATCH /sessions/:id/public -> {session_id,
 *     sharing_scope}; GET /sessions/:id/pre-provisioned-check -> {valid,
 *     session_id|null}; GET /sessions/:id/sandbox-status -> {status};
 *     GET /sessions/:id/messages -> {messages: [...]}; GET artifacts -> a
 *     DIRECT ARRAY of ApiArtifactResponse (not wrapped); GET outputs ->
 *     OutputInventory {files, complete}; GET output-cards -> {cards};
 *     GET webapp-info -> ApiWebappInfoResponse; GET files -> DirectoryListing.
 *   - STREAM DEVIATION vs the naive SSE-per-request design: the craft
 *     frontend does NOT parse the send-message response as a stream.
 *     createTurn (apiServices.ts) POSTs /sessions/:id/send-message and
 *     expects JSON ApiInteractiveTurnResponse {turn_id, session_id, status,
 *     turn_index, error_detail}; it then ATTACHES to the accepted turn via
 *     GET /sessions/:id/turns/:turnId/events (fetchTurnEventStream) and
 *     parses THAT with processSSEStream — SSE `data: {json}` frames; the
 *     packet type always lives in data.type (`event: message` is a fallback
 *     only). So this port: send-message persists the user message, creates
 *     the turn, starts generation in the background and returns the turn
 *     JSON immediately; the events endpoint replays buffered packets, then
 *     streams live ones until turn_completed arrives.
 *   - web/src/app/craft/hooks/useBuildStreaming.ts + utils/parsePacket.ts +
 *     utils/packetTypes.ts — packet types the client understands:
 *     agent_message_chunk / agent_thought_chunk ({content: string |
 *     {type:"text",text} | [{type:"text",text},...]}), tool_call_start /
 *     tool_call_progress, prompt_response, turn_completed ({session_id,
 *     turn_id, turn_index:number>=0, status: SUCCEEDED|FAILED|CANCELLED,
 *     error_detail}), artifact_created ({artifact:{id,type,name,path,
 *     preview_url}}), error ({message}), context_usage ({used_tokens}).
 *     This no-sandbox port emits agent_thought_chunk + agent_message_chunk
 *     deltas, artifact_created and the terminal turn_completed.
 *   - web/src/app/craft/hooks/useBuildSessionStore.ts — loadSession skips
 *     its restore flow when sandbox.status === "running" &&
 *     session_loaded_in_sandbox === true; the reloaded transcript is built
 *     ONLY from message_metadata (convertMessagesToStreamItems drops
 *     assistant rows without packet metadata), hence every assistant row
 *     persists {type:"agent_message", content} metadata.
 *   - Session list view uses only id/name/created_at
 *     (fetchSessionHistory -> SessionHistoryItem).
 *
 * DEVIATIONS (documented):
 *   - No microVM sandbox (see craft/artifacts.ts header): sandbox-status is
 *     always "running", restore is a no-op returning the ready session, and
 *     outputs / files / webapp-info / output-cards return the faithful empty
 *     shapes (the frontend renders empty outputs/files panels and treats
 *     has_webapp:false as "no webapp"; waitForWebappReady returns false
 *     immediately, so no 30s poll hang).
 *   - Turn events are buffered in-memory per process; after a restart an
 *     in-flight turn reports no active turn, which the frontend treats as a
 *     settled turn.
 *   - The build agent is a plain streamed LLM completion via
 *     getLLMProvider() (no tools) — Standard runs the opencode agent inside
 *     a per-session sandbox; that runtime is out of scope here.
 *   - POST /sessions/:id/upload responds 501: there is no sandbox filesystem
 *     to receive uploads (attachments are optional in the input bar).
 *
 * ARTIFACT LINKING: build artifacts reuse the shared `artifact` table
 * (migration 0001), whose chat_session_id column is a bare UUID with NO
 * foreign key (src/craft/artifacts.ts header documents the ownership model).
 * build_session ids are UUIDs, so artifact rows store the build-session id
 * directly in chat_session_id; ownership checks below join build_session
 * instead of chat_session. The craft/artifacts.ts helpers are NOT reused for
 * writes because assertChatSessionWritable validates against chat_session.
 * The artifact's sandbox path is derived from its row id (outputs/<id>.md),
 * which round-trips deterministically through GET /sessions/:id/artifacts/
 * :path without needing a path column.
 */

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { query, queryOne } from "../../db/client";
import { getAuth, requireAuth } from "../../auth/middleware";
import type { User } from "../../types/domain";
import { getLogger } from "../../utils/logger";
import {
  InvalidRequestError,
  NotFoundError,
  UnauthorizedError,
  UnsupportedFeatureError,
} from "../../utils/errors";
import { getLLMProvider } from "../../llm/factory";
import type { LLMMessage, LLMStreamEvent } from "../../llm/types";

const logger = getLogger("server.routes.build");

export const buildRoutes = new Hono();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** SSE keepalive interval so proxies don't kill a silent events stream. */
const HEARTBEAT_INTERVAL_MS = 15_000;
/** Max prior messages replayed to the LLM as history. */
const MAX_HISTORY_MESSAGES = 24;
/** Terminal turns are dropped from the in-memory registry after this. */
const SETTLED_TURN_TTL_MS = 30 * 60 * 1000;

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// Unanchored variant for extracting an artifact id from a sandbox path like
// "outputs/<uuid>.md" (UUID_RE above is full-string anchored).
const PATH_UUID_RE =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

function assertUuid(value: string, what: string): void {
  if (!UUID_RE.test(value)) {
    throw new InvalidRequestError(`${what} must be a uuid, got: '${value}'`);
  }
}

/**
 * System prompt for the no-sandbox build agent. The Standard backend runs the
 * opencode agent inside a per-session sandbox; this port streams a single
 * completion instead (see header deviations).
 */
const CRAFT_SYSTEM_PROMPT = `You are the Onyx Craft build assistant. The user asks you to build or create something — an app or web page concept, a document, a report, a script, a plan, or analysis.

There is no live code-execution sandbox in this deployment, so you cannot run commands; instead your final response IS the deliverable. Respond with a complete, high-quality Markdown document:

1. Start with a short summary of what you are delivering.
2. Then provide the deliverable itself:
   - For app/web requests: a concrete blueprint — feature plan, file-by-file implementation outline, and the key files as complete fenced code blocks with language tags.
   - For documents/reports/analysis: the full finished document.
3. End with a brief "Next steps" list.

Use proper Markdown: headings, lists, tables, and fenced code blocks with language annotations. Be concrete and complete — your response is saved verbatim as a Markdown artifact the user can preview and download.`;

// ---------------------------------------------------------------------------
// Wire shapes (mirror web/src/app/craft/types/streamingTypes.ts)
// ---------------------------------------------------------------------------

interface ApiSandboxJson {
  id: string;
  status: "provisioning" | "running" | "sleeping" | "terminated" | "failed";
  container_id: string | null;
  created_at: string;
  last_heartbeat: string | null;
}

interface ApiSessionJson {
  id: string;
  user_id: string | null;
  name: string | null;
  status: "initializing" | "active" | "idle" | "failed";
  created_at: string;
  last_activity_at: string;
  nextjs_port: number | null;
  sandbox: ApiSandboxJson | null;
  artifacts: ApiArtifactJson[];
  sharing_scope: "private" | "public_org";
  origin: "INTERACTIVE" | "SCHEDULED" | "SLACK";
  agent_provider: string | null;
  agent_model: string | null;
  skills_stale: boolean;
}

interface ApiDetailedSessionJson extends ApiSessionJson {
  session_loaded_in_sandbox: boolean;
}

interface ApiArtifactJson {
  id: string;
  session_id: string;
  type: string;
  path: string;
  name: string;
  created_at: string;
  updated_at: string;
  preview_url: string | null;
}

interface ApiMessageJson {
  id: string;
  session_id: string;
  turn_index: number;
  type: "user" | "assistant";
  content: string;
  message_metadata: unknown;
  created_at: string;
}

interface ApiTurnJson {
  turn_id: string;
  session_id: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  turn_index: number;
  error_detail: string | null;
}

/** Loose packet shape — parsePacket.ts decodes unknown objects defensively. */
type BuildPacket = Record<string, unknown>;

// ---------------------------------------------------------------------------
// DB rows
// ---------------------------------------------------------------------------

interface BuildSessionRow {
  id: string;
  user_id: string | null;
  name: string;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface BuildMessageRow {
  id: number;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  turn_id: number | null;
  message_metadata: unknown;
  created_at: Date | string;
}

interface ArtifactRow {
  id: string;
  chat_session_id: string | null;
  title: string;
  content: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// ---------------------------------------------------------------------------
// Body validation (same pattern as routes/artifacts.ts)
// ---------------------------------------------------------------------------

function parseBody<T>(
  result: { success: boolean; data?: T; error?: z.ZodError },
): T {
  if (!result.success) {
    const issues = (result.error?.issues ?? [])
      .map((i) => `${i.path.map(String).join(".")}: ${i.message}`)
      .join("; ");
    throw new InvalidRequestError(`invalid request body: ${issues}`);
  }
  return result.data as T;
}

const createSessionSchema = z.object({
  name: z.string().min(1).nullable().optional(),
});

const renameSchema = z.object({
  name: z.string().min(1).nullable(),
});

const sharingSchema = z.object({
  sharing_scope: z.enum(["private", "public_org"]),
});

/**
 * Send-message body. `provider_id` arrives as the numeric llm_provider.id
 * from the frontend model picker (web/src/app/craft/services/apiServices.ts
 * sends model?.providerId), and as a string from older callers — accept both
 * and normalize below.
 */
const sendMessageSchema = z.object({
  content: z.string().min(1),
  client_request_id: z.string().optional(),
  attachments: z
    .array(
      z.object({
        name: z.string(),
        path: z.string(),
        mime_type: z.string(),
      }),
    )
    .optional(),
  provider: z.string().optional(),
  provider_id: z.union([z.string(), z.number()]).optional(),
  model: z.string().optional(),
});

/**
 * Normalize the picked provider into factory terms: a numeric id (or numeric
 * string) resolves through llm_provider.provider ("zai" / "kilo" /
 * "openai-compatible"), with the row's default_model_name filling in an
 * unset model. Anything else passes through untouched.
 */
async function normalizeCraftProvider(
  providerId: string | number | undefined,
  model: string | undefined,
): Promise<{ providerId?: string; modelName?: string }> {
  if (providerId === undefined) return { providerId: undefined, modelName: model };
  const asNumber = typeof providerId === "number" ? providerId : Number(providerId);
  if (!Number.isFinite(asNumber) || `${asNumber}` !== `${providerId}`.trim()) {
    return { providerId: providerId as string, modelName: model };
  }
  const row = await queryOne<{ provider: string; default_model_name: string | null }>(
    `SELECT provider, default_model_name FROM llm_provider WHERE id = $1 LIMIT 1`,
    [asNumber],
  );
  if (!row) return { providerId: undefined, modelName: model };
  return {
    providerId: row.provider,
    modelName: model ?? row.default_model_name ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Auth + session ownership
// ---------------------------------------------------------------------------

/** Read the user stored by the requireAuth middleware (401 when absent). */
function currentUser(c: Context): User {
  const auth = getAuth(c);
  if (!auth) throw new UnauthorizedError();
  return auth.user;
}

/** Load a build session the caller owns, or 404. */
async function getOwnedSession(userId: string, sessionId: string): Promise<BuildSessionRow> {
  assertUuid(sessionId, "session id");
  const row = await queryOne<BuildSessionRow>(
    `SELECT id, user_id, name, status, created_at, updated_at
     FROM build_session WHERE id = $1 AND user_id = $2`,
    [sessionId, userId],
  );
  if (!row) throw new NotFoundError("Build session");
  return row;
}

// ---------------------------------------------------------------------------
// Response shape builders
// ---------------------------------------------------------------------------

function toSandboxJson(session: BuildSessionRow): ApiSandboxJson {
  // Static "running" sandbox — this port has no container runtime. sandbox.id
  // must be stable per session (the store keys runtime comparisons on it).
  return {
    id: session.id,
    status: "running",
    container_id: null,
    created_at: toIso(session.created_at),
    last_heartbeat: null,
  };
}

function toApiArtifact(row: ArtifactRow): ApiArtifactJson {
  return {
    id: row.id,
    session_id: row.chat_session_id ?? "",
    // Only markdown artifacts are produced by this port's build agent.
    type: "markdown",
    name: row.title,
    path: artifactPath(row.id),
    preview_url: null,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

/** Deterministic sandbox path for an artifact row (see header linking note). */
function artifactPath(artifactId: string): string {
  return `outputs/${artifactId}.md`;
}

async function listSessionArtifacts(sessionId: string): Promise<ApiArtifactJson[]> {
  const res = await query<ArtifactRow>(
    `SELECT id, chat_session_id, title, content, created_at, updated_at
     FROM artifact
     WHERE chat_session_id = $1
     ORDER BY created_at ASC, id ASC`,
    [sessionId],
  );
  return res.rows.map(toApiArtifact);
}

function toApiSession(
  session: BuildSessionRow,
  artifacts: ApiArtifactJson[],
): ApiSessionJson {
  return {
    id: session.id,
    user_id: session.user_id,
    name: session.name,
    // Always "active": no provisioning pipeline exists in this port, and
    // mapApiSessionStatus maps "active" straight to the client's ready state.
    status: "active",
    created_at: toIso(session.created_at),
    last_activity_at: toIso(session.updated_at),
    nextjs_port: null,
    sandbox: toSandboxJson(session),
    artifacts,
    sharing_scope: "private",
    origin: "INTERACTIVE",
    agent_provider: null,
    agent_model: null,
    skills_stale: false,
  };
}

function toDetailedApiSession(
  session: BuildSessionRow,
  artifacts: ApiArtifactJson[],
): ApiDetailedSessionJson {
  return {
    ...toApiSession(session, artifacts),
    // loadSession skips its restore flow when the sandbox is "running" and
    // the workspace is loaded (useBuildSessionStore.ts needsRestore).
    session_loaded_in_sandbox: true,
  };
}

async function detailedSessionResponse(session: BuildSessionRow): Promise<ApiDetailedSessionJson> {
  const artifacts = await listSessionArtifacts(session.id);
  return toDetailedApiSession(session, artifacts);
}

function toApiMessage(row: BuildMessageRow): ApiMessageJson {
  return {
    id: String(row.id),
    session_id: row.session_id,
    // turn_id column stores the 0-based turn index (see migration 0012 note).
    turn_index: row.turn_id ?? 0,
    type: row.role,
    content: row.content,
    message_metadata: row.message_metadata ?? null,
    created_at: toIso(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Turn registry (in-memory, per process)
// ---------------------------------------------------------------------------

type TurnStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

interface TurnSubscriber {
  push(frame: string): void;
  close(): void;
}

interface BuildTurn {
  turnId: string;
  sessionId: string;
  /** 0-based turn index — reported as turn_index and stored in build_message.turn_id. */
  index: number;
  status: TurnStatus;
  errorDetail: string | null;
  /** Buffered packets, replayed to every attaching SSE client. */
  events: BuildPacket[];
  subscribers: Set<TurnSubscriber>;
  abort: AbortController;
  settledAt: number | null;
}

const turns = new Map<string, BuildTurn>();

function isTerminal(status: TurnStatus): boolean {
  return status === "SUCCEEDED" || status === "FAILED" || status === "CANCELLED";
}

function findActiveTurn(sessionId: string): BuildTurn | null {
  for (const turn of turns.values()) {
    if (turn.sessionId === sessionId && !isTerminal(turn.status)) return turn;
  }
  return null;
}

function findTurn(sessionId: string, turnId: string): BuildTurn | null {
  const turn = turns.get(turnId);
  return turn && turn.sessionId === sessionId ? turn : null;
}

function purgeStaleTurns(): void {
  const now = Date.now();
  for (const [turnId, turn] of turns) {
    if (turn.settledAt !== null && now - turn.settledAt > SETTLED_TURN_TTL_MS) {
      turns.delete(turnId);
    }
  }
}

/** Buffer a packet, fan it out to live SSE subscribers, close on terminal. */
function publish(turn: BuildTurn, packet: BuildPacket): void {
  turn.events.push(packet);
  for (const subscriber of turn.subscribers) {
    subscriber.push(JSON.stringify(packet));
    if (isTerminal(turn.status)) subscriber.close();
  }
  if (isTerminal(turn.status)) turn.subscribers.clear();
}

/** SSE frames for the turn-event stream (the wire format processSSEStream parses). */
function sseFrame(json: string): string {
  return `data: ${json}\n\n`;
}

/**
 * Attach a live SSE stream to a turn: replay buffered packets, then forward
 * new ones until the terminal turn_completed packet. The frontend reconnect
 * loop (streamTurnEvents) tolerates the stream ending — after turn_completed
 * it settles the turn from the persisted transcript.
 */
function turnEventStream(turn: BuildTurn): Response {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  // The subscriber created by THIS stream, so cancel() only tears down its
  // own registration (a turn can serve several sequential SSE attaches).
  let ownSubscriber: TurnSubscriber | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const clearHeartbeat = () => {
        if (heartbeat !== null) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
      };
      const subscriber: TurnSubscriber = {
        push(json: string) {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(sseFrame(json)));
          } catch {
            closed = true;
            clearHeartbeat();
          }
        },
        close() {
          if (closed) return;
          closed = true;
          clearHeartbeat();
          turn.subscribers.delete(subscriber);
          try {
            controller.close();
          } catch {
            // already closed
          }
        },
      };

      // Replay the buffer first (attach happens after send-message returns).
      for (const packet of turn.events) {
        subscriber.push(JSON.stringify(packet));
      }
      if (isTerminal(turn.status)) {
        subscriber.close();
        return;
      }

      ownSubscriber = subscriber;
      turn.subscribers.add(subscriber);
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          // SSE comment line — processSSEStream ignores non-data lines.
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          closed = true;
          clearHeartbeat();
        }
      }, HEARTBEAT_INTERVAL_MS);
    },
    cancel() {
      // Client aborted the fetch: deregister only this stream's subscriber.
      if (ownSubscriber) ownSubscriber.close();
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Serverless cross-instance fallback for the turn-events attach. The turn
 * registry lives per function instance; Vercel may serve the send-message
 * POST and this events GET on different instances (or the originating
 * instance may have been recycled). When the turn id is unknown here,
 * synthesize the packet stream from the DB-persisted transcript instead of
 * 404ing: poll build_message for the assistant row of the latest turn and
 * emit agent_message + turn_completed when it lands (the generation runs on
 * whichever instance accepted the POST and persists there on completion).
 * Bounded wait, then a terminal turn_completed FAILED so the client settles.
 */
const SYNTH_POLL_INTERVAL_MS = 1_500;
const SYNTH_MAX_WAIT_MS = 55_000;

async function synthesizedTurnEventStream(
  sessionId: string,
  turnId: string
): Promise<Response> {
  const encoder = new TextEncoder();
  const startedAt = Date.now();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const push = (json: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseFrame(json)));
        } catch {
          closed = true;
        }
      };
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          // SSE comment line — processSSEStream ignores non-data lines.
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          closed = true;
        }
      }, HEARTBEAT_INTERVAL_MS);
      try {
        // The latest user row of this session marks the turn being attached
        // (the client only attaches to the active — i.e. latest — turn;
        // historical turns render from the persisted transcript).
        const latestUser = await queryOne<{ turn_id: number | null; content: string }>(
          `SELECT turn_id, content FROM build_message
            WHERE session_id = $1 AND role = 'user'
            ORDER BY id DESC LIMIT 1`,
          [sessionId],
        );
        const turnIndex = latestUser?.turn_id ?? 0;
        if (latestUser) {
          push(JSON.stringify({ type: "user_message", content: latestUser.content }));
        }
        let assistant: { content: string } | null = null;
        while (Date.now() - startedAt < SYNTH_MAX_WAIT_MS) {
          if (closed) return;
          const row = await queryOne<{ content: string }>(
            `SELECT content FROM build_message
              WHERE session_id = $1 AND role = 'assistant' AND turn_id = $2
              ORDER BY id DESC LIMIT 1`,
            [sessionId, turnIndex],
          );
          if (row) {
            assistant = row;
            break;
          }
          await new Promise((r) => setTimeout(r, SYNTH_POLL_INTERVAL_MS));
        }
        if (closed) return;
        if (assistant) {
          push(JSON.stringify({ type: "agent_message", content: assistant.content }));
          push(
            JSON.stringify({
              type: "turn_completed",
              session_id: sessionId,
              turn_id: turnId,
              turn_index: turnIndex,
              status: "SUCCEEDED",
              error_detail: null,
            }),
          );
        } else {
          push(
            JSON.stringify({
              type: "turn_completed",
              session_id: sessionId,
              turn_id: turnId,
              turn_index: turnIndex,
              status: "FAILED",
              error_detail: "Turn state unavailable (serverless instance recycled)",
            }),
          );
        }
      } catch (err) {
        if (!closed) {
          push(
            JSON.stringify({
              type: "turn_completed",
              session_id: sessionId,
              turn_id: turnId,
              turn_index: 0,
              status: "FAILED",
              error_detail: `Turn replay failed: ${String(err)}`,
            }),
          );
        }
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// ---------------------------------------------------------------------------
// Build agent generation (plain streamed LLM completion — no tools)
// ---------------------------------------------------------------------------

function deriveTitle(prompt: string, fallback: string): string {
  const firstLine =
    prompt
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const cleaned = firstLine
    .replace(/^[#>*\-\d.\s`]+/, "")
    .replace(/[`*_#]/g, "")
    .trim();
  const title = cleaned.length > 0 ? cleaned : fallback;
  return title.length > 60 ? `${title.slice(0, 57).trimEnd()}...` : title;
}

interface TurnRunInput {
  turn: BuildTurn;
  userId: string;
  prompt: string;
  history: LLMMessage[];
  providerId?: string;
  modelName?: string;
}

/**
 * Run one build turn in the background: stream the LLM, emit
 * agent_message_chunk packets, then persist the assistant message, create the
 * markdown artifact and emit artifact_created + the terminal turn_completed.
 * Never throws — failures are reported as FAILED turns.
 */
async function runTurn(input: TurnRunInput): Promise<void> {
  const { turn, userId, prompt, history } = input;
  const sessionId = turn.sessionId;
  let full = "";
  try {
    const provider = await getLLMProvider(input.providerId, input.modelName);
    const messages: LLMMessage[] = [
      { role: "system", content: CRAFT_SYSTEM_PROMPT },
      ...history,
      { role: "user", content: prompt },
    ];
    const stream = provider.stream(messages, {
      signal: turn.abort.signal,
      maxTokens: 4096,
    });
    for await (const event of stream as AsyncGenerator<LLMStreamEvent, void, unknown>) {
      if (turn.abort.signal.aborted) break;
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (!delta) continue;
      full += delta;
      publish(turn, { type: "agent_message_chunk", content: delta });
    }

    if (!turn.abort.signal.aborted) {
      // Persist the deliverable as an artifact (title from the prompt,
      // content = final answer) linked via artifact.chat_session_id
      // = build_session id (see header linking note).
      const title = deriveTitle(prompt, "Build output");
      const artifact = await queryOne<ArtifactRow>(
        `INSERT INTO artifact (id, chat_session_id, title, content)
         VALUES ($1, $2, $3, $4)
         RETURNING id, chat_session_id, title, content, created_at, updated_at`,
        [randomUUID(), sessionId, title, full],
      );
      if (artifact) {
        publish(turn, {
          type: "artifact_created",
          artifact: {
            id: artifact.id,
            type: "markdown",
            name: artifact.title,
            path: artifactPath(artifact.id),
            preview_url: null,
          },
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Persist the assistant message with the packet metadata the reload path
    // requires (useBuildSessionStore.convertMessagesToStreamItems parses
    // message_metadata through parsePacket — {type:"agent_message"} is the
    // DB-stored text format).
    await query(
      `INSERT INTO build_message (session_id, role, content, turn_id, message_metadata)
       VALUES ($1, 'assistant', $2, $3, $4::jsonb)`,
      [
        sessionId,
        full,
        turn.index,
        JSON.stringify({ type: "agent_message", content: full }),
      ],
    );
    await query(`UPDATE build_session SET updated_at = now() WHERE id = $1`, [sessionId]);

    if (turn.abort.signal.aborted) {
      turn.status = "CANCELLED";
    } else {
      turn.status = "SUCCEEDED";
    }
    logger.info("build turn completed", {
      sessionId,
      turnId: turn.turnId,
      status: turn.status,
      chars: full.length,
      userId,
    });
  } catch (err) {
    const aborted = turn.abort.signal.aborted || (err instanceof Error && err.name === "AbortError");
    if (aborted) {
      turn.status = "CANCELLED";
      logger.info("build turn cancelled", { sessionId, turnId: turn.turnId });
    } else {
      turn.status = "FAILED";
      turn.errorDetail = err instanceof Error ? err.message : String(err);
      logger.error("build turn failed", {
        sessionId,
        turnId: turn.turnId,
        error: turn.errorDetail,
      });
      publish(turn, { type: "error", message: turn.errorDetail ?? "Build turn failed" });
      // Persist the failure so the reloaded transcript keeps the error card.
      try {
        await query(
          `INSERT INTO build_message (session_id, role, content, turn_id, message_metadata)
           VALUES ($1, 'assistant', $2, $3, $4::jsonb)`,
          [
            sessionId,
            full,
            turn.index,
            JSON.stringify({
              type: "error",
              message: turn.errorDetail ?? "Build turn failed",
            }),
          ],
        );
      } catch (persistErr) {
        logger.warning("failed to persist build turn error", {
          error: String(persistErr),
        });
      }
    }
  } finally {
    turn.settledAt = Date.now();
    publish(turn, {
      type: "turn_completed",
      session_id: sessionId,
      turn_id: turn.turnId,
      turn_index: turn.index,
      status: turn.status,
      error_detail: turn.errorDetail,
    });
  }
}

/** Load prior messages as LLM history (oldest-first, capped). */
async function loadHistory(sessionId: string): Promise<LLMMessage[]> {
  const res = await query<Pick<BuildMessageRow, "role" | "content">>(
    `SELECT role, content FROM build_message
     WHERE session_id = $1 ORDER BY id DESC LIMIT $2`,
    [sessionId, MAX_HISTORY_MESSAGES],
  );
  return res.rows
    .reverse()
    .map((row) => ({ role: row.role, content: row.content }) as LLMMessage);
}

// ---------------------------------------------------------------------------
// Session routes
// ---------------------------------------------------------------------------

/**
 * GET /sessions — session history, newest first. Mirrors SessionListResponse;
 * the frontend maps each entry to {id, title: name, createdAt} and the
 * backend historically excludes empty sessions (see the optimistic-history
 * comment in useBuildSessionStore.consumePreProvisionedSession), so sessions
 * without any message are filtered out here too.
 */
buildRoutes.get("/sessions", requireAuth, async (c) => {
  const user = currentUser(c);
  const res = await query<BuildSessionRow>(
    `SELECT s.id, s.user_id, s.name, s.status, s.created_at, s.updated_at
     FROM build_session s
     WHERE s.user_id = $1
       AND EXISTS (SELECT 1 FROM build_message m WHERE m.session_id = s.id)
     ORDER BY s.updated_at DESC`,
    [user.id],
  );
  // The list view never reads per-session artifacts (fetchSessionHistory);
  // the detail endpoint serves the full artifact list.
  const sessions = res.rows.map((row) => toApiSession(row, []));
  return c.json({ sessions });
});

/** POST /sessions — create a build session (body may carry a name). */
buildRoutes.post("/sessions", requireAuth, async (c) => {
  const user = currentUser(c);
  const body = parseBody(createSessionSchema.safeParse(await c.req.json().catch(() => ({}))));
  const name = (body.name ?? "New Build").trim() || "New Build";
  const row = await queryOne<BuildSessionRow>(
    `INSERT INTO build_session (user_id, name) VALUES ($1, $2)
     RETURNING id, user_id, name, status, created_at, updated_at`,
    [user.id, name],
  );
  if (!row) throw new Error("build_session insert returned no row");
  logger.info("build session created", { sessionId: row.id, userId: user.id });
  purgeStaleTurns();
  return c.json(await detailedSessionResponse(row), 201);
});

/**
 * GET /sessions/:id — session detail (ApiDetailedSessionResponse). The
 * artifacts array is included for shape parity, but the frontend fetches
 * artifacts separately via GET /sessions/:id/artifacts.
 */
buildRoutes.get("/sessions/:id", requireAuth, async (c) => {
  const user = currentUser(c);
  const session = await getOwnedSession(user.id, c.req.param("id"));
  return c.json(await detailedSessionResponse(session));
});

/** DELETE /sessions/:id — remove the session, its messages and artifacts. */
buildRoutes.delete("/sessions/:id", requireAuth, async (c) => {
  const user = currentUser(c);
  const session = await getOwnedSession(user.id, c.req.param("id"));
  // Linked artifacts first (no FK between artifact.chat_session_id and
  // build_session, so cascade would not cover them).
  await query(`DELETE FROM artifact WHERE chat_session_id = $1`, [session.id]);
  await query(`DELETE FROM build_session WHERE id = $1`, [session.id]);
  for (const [turnId, turn] of turns) {
    if (turn.sessionId === session.id) turns.delete(turnId);
  }
  return c.json({ deleted: true });
});

/**
 * PUT /sessions/:id/name (+ POST alias) — rename, or auto-name when
 * name is null. The frontend's nameBuildSession sends {name: null} after the
 * first turn and expects the generated name back (apiServices.ts
 * updateSessionName).
 */
async function renameSession(c: Context, sessionId: string): Promise<Response> {
  const user = currentUser(c);
  const session = await getOwnedSession(user.id, sessionId);
  const body = parseBody(renameSchema.safeParse(await c.req.json()));
  let name: string;
  if (body.name !== null) {
    name = body.name.trim();
    if (!name) throw new InvalidRequestError("session name must not be empty");
  } else {
    // Auto-name from the first user message (chat/persistence.ts heuristic).
    const first = await queryOne<Pick<BuildMessageRow, "content">>(
      `SELECT content FROM build_message
       WHERE session_id = $1 AND role = 'user' ORDER BY id ASC LIMIT 1`,
      [session.id],
    );
    name = first ? deriveTitle(first.content, session.name) : session.name;
  }
  const row = await queryOne<BuildSessionRow>(
    `UPDATE build_session SET name = $2, updated_at = now() WHERE id = $1
     RETURNING id, user_id, name, status, created_at, updated_at`,
    [session.id, name],
  );
  if (!row) throw new NotFoundError("Build session");
  const artifacts = await listSessionArtifacts(session.id);
  return c.json(toApiSession(row, artifacts));
}

buildRoutes.put("/sessions/:id/name", requireAuth, (c) => renameSession(c, c.req.param("id")));
buildRoutes.post("/sessions/:id/name", requireAuth, (c) => renameSession(c, c.req.param("id")));

/**
 * PATCH /sessions/:id/public — sharing toggle. This port has no shared-
 * session serving, so the scope is accepted and echoed (the shape
 * setSessionSharing expects), not persisted.
 */
buildRoutes.patch("/sessions/:id/public", requireAuth, async (c) => {
  const user = currentUser(c);
  const session = await getOwnedSession(user.id, c.req.param("id"));
  const body = parseBody(sharingSchema.safeParse(await c.req.json()));
  return c.json({ session_id: session.id, sharing_scope: body.sharing_scope });
});

// ---------------------------------------------------------------------------
// Lifecycle / readiness routes (no real sandbox — static ready shapes)
// ---------------------------------------------------------------------------

/**
 * GET /sessions/:id/pre-provisioned-check — {valid, session_id|null}.
 * "Valid" means the pre-provisioned session is still unused (no messages);
 * used to re-provision when another tab claimed it (usePreProvisionPolling).
 */
buildRoutes.get("/sessions/:id/pre-provisioned-check", requireAuth, async (c) => {
  const user = currentUser(c);
  const session = await getOwnedSession(user.id, c.req.param("id"));
  const row = await queryOne<{ has_messages: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM build_message WHERE session_id = $1
     ) AS has_messages`,
    [session.id],
  );
  const valid = !(row?.has_messages ?? false);
  return c.json({ valid, session_id: valid ? session.id : null });
});

/** GET /sessions/:id/sandbox-status — static ready sandbox (no runtime). */
buildRoutes.get("/sessions/:id/sandbox-status", requireAuth, async (c) => {
  const user = currentUser(c);
  const session = await getOwnedSession(user.id, c.req.param("id"));
  return c.json({ status: toSandboxJson(session).status });
});

/** POST /sessions/:id/restore — no-op restore returning the ready session. */
buildRoutes.post("/sessions/:id/restore", requireAuth, async (c) => {
  const user = currentUser(c);
  const session = await getOwnedSession(user.id, c.req.param("id"));
  return c.json(await detailedSessionResponse(session));
});

/** POST /sessions/:id/skills/reload — no skills runtime; never stale. */
buildRoutes.post("/sessions/:id/skills/reload", requireAuth, async (c) => {
  const user = currentUser(c);
  await getOwnedSession(user.id, c.req.param("id"));
  return c.json({ skills_stale: false });
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** GET /sessions/:id/messages — persisted transcript (MessageListResponse). */
buildRoutes.get("/sessions/:id/messages", requireAuth, async (c) => {
  const user = currentUser(c);
  const session = await getOwnedSession(user.id, c.req.param("id"));
  const res = await query<BuildMessageRow>(
    `SELECT id, session_id, role, content, turn_id, message_metadata, created_at
     FROM build_message WHERE session_id = $1 ORDER BY id ASC`,
    [session.id],
  );
  return c.json({ messages: res.rows.map(toApiMessage) });
});

// ---------------------------------------------------------------------------
// Turn lifecycle (send-message + turn event streams)
// ---------------------------------------------------------------------------

/**
 * POST /sessions/:id/send-message — the core endpoint. NOTE the wire contract
 * (see header): the response is JSON ApiInteractiveTurnResponse, NOT a
 * stream. The user message is persisted here; generation runs in the
 * background and its packets are served by
 * GET /sessions/:id/turns/:turnId/events.
 */
buildRoutes.post("/sessions/:id/send-message", requireAuth, async (c) => {
  const user = currentUser(c);
  const session = await getOwnedSession(user.id, c.req.param("id"));
  const body = parseBody(sendMessageSchema.safeParse(await c.req.json()));

  const countRow = await queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM build_message
     WHERE session_id = $1 AND role = 'user'`,
    [session.id],
  );
  const turnIndex = countRow?.count ?? 0;

  // History is read BEFORE the user row is inserted (the prompt is appended
  // as the final user message at generation time).
  const history = await loadHistory(session.id);

  await query(
    `INSERT INTO build_message (session_id, role, content, turn_id, message_metadata)
     VALUES ($1, 'user', $2, $3, $4::jsonb)`,
    [
      session.id,
      body.content,
      turnIndex,
      JSON.stringify({
        type: "user_message",
        content: { type: "text", text: body.content },
        attachments: body.attachments ?? [],
      }),
    ],
  );
  await query(`UPDATE build_session SET updated_at = now() WHERE id = $1`, [session.id]);

  const turn: BuildTurn = {
    turnId: randomUUID(),
    sessionId: session.id,
    index: turnIndex,
    status: "RUNNING",
    errorDetail: null,
    events: [],
    subscribers: new Set(),
    abort: new AbortController(),
    settledAt: null,
  };
  turns.set(turn.turnId, turn);
  purgeStaleTurns();

  const response: ApiTurnJson = {
    turn_id: turn.turnId,
    session_id: session.id,
    status: "RUNNING",
    turn_index: turnIndex,
    error_detail: null,
  };

  // Fire-and-forget generation; runTurn never rejects.
  const picked = await normalizeCraftProvider(body.provider_id, body.model);
  void runTurn({
    turn,
    userId: user.id,
    prompt: body.content,
    history,
    // provider/model are the per-message picker overrides
    // (BuildLlmSelection); unset falls back to the default provider.
    providerId: picked.providerId,
    modelName: picked.modelName,
  }).catch((err) => {
    logger.error("build turn crashed", { error: String(err), turnId: turn.turnId });
  });

  return c.json(response);
});

/**
 * GET /sessions/:id/turns/active — the in-flight turn or JSON null
 * (fetchActiveTurn treats a null body as "no active turn").
 */
buildRoutes.get("/sessions/:id/turns/active", requireAuth, async (c) => {
  const user = currentUser(c);
  const session = await getOwnedSession(user.id, c.req.param("id"));
  const turn = findActiveTurn(session.id);
  if (!turn) return c.json(null);
  const response: ApiTurnJson = {
    turn_id: turn.turnId,
    session_id: session.id,
    status: turn.status,
    turn_index: turn.index,
    error_detail: turn.errorDetail,
  };
  return c.json(response);
});

/** GET /sessions/:id/turns/:turnId — a known turn (fetchKnownTurn). */
buildRoutes.get("/sessions/:id/turns/:turnId", requireAuth, async (c) => {
  const user = currentUser(c);
  const session = await getOwnedSession(user.id, c.req.param("id"));
  const turn = findTurn(session.id, c.req.param("turnId"));
  if (!turn) throw new NotFoundError("Turn");
  const response: ApiTurnJson = {
    turn_id: turn.turnId,
    session_id: session.id,
    status: turn.status,
    turn_index: turn.index,
    error_detail: turn.errorDetail,
  };
  return c.json(response);
});

/**
 * GET /sessions/:id/turns/:turnId/events — the SSE packet stream the craft
 * client parses with processSSEStream + parsePacket. Replays the buffered
 * packets, streams live ones, and ends after the terminal turn_completed.
 */
buildRoutes.get("/sessions/:id/turns/:turnId/events", requireAuth, async (c) => {
  const user = currentUser(c);
  const session = await getOwnedSession(user.id, c.req.param("id"));
  const turn = findTurn(session.id, c.req.param("turnId"));
  // Cross-instance serverless fallback: unknown turn id here does not mean
  // the turn is gone — the POST may have landed on another instance. Replay
  // from the DB instead of 404ing so the client always settles.
  if (!turn) return await synthesizedTurnEventStream(session.id, c.req.param("turnId"));
  return turnEventStream(turn);
});

/**
 * POST /sessions/:id/interrupt — abort the in-flight turn. The events stream
 * then terminates with turn_completed CANCELLED (the frontend keeps partial
 * output visible and settles normally).
 */
buildRoutes.post("/sessions/:id/interrupt", requireAuth, async (c) => {
  const user = currentUser(c);
  const session = await getOwnedSession(user.id, c.req.param("id"));
  const turn = findActiveTurn(session.id);
  if (!turn) return c.json({ interrupted: false });
  turn.abort.abort();
  return c.json({ interrupted: true });
});

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

/**
 * GET /sessions/:id/artifacts — DIRECT ARRAY of ApiArtifactResponse (the
 * frontend maps the array itself; it is not wrapped in an object — see the
 * comment in fetchArtifacts).
 */
buildRoutes.get("/sessions/:id/artifacts", requireAuth, async (c) => {
  const user = currentUser(c);
  const session = await getOwnedSession(user.id, c.req.param("id"));
  return c.json(await listSessionArtifacts(session.id));
});

/**
 * GET /sessions/:id/artifacts/:path — raw artifact content. The frontend's
 * fetchFileContent reads the body as text when Content-Type matches
 * text/* (or the path has a source-file extension), so raw text/plain is the
 * correct response. Paths carry the artifact row id (outputs/<id>.md).
 */
buildRoutes.get("/sessions/:id/artifacts/:path{.+}", requireAuth, async (c) => {
  const user = currentUser(c);
  const session = await getOwnedSession(user.id, c.req.param("id"));
  const rawPath = c.req.param("path");
  const match = PATH_UUID_RE.exec(rawPath);
  if (!match) throw new NotFoundError("Artifact");
  const artifact = await queryOne<Pick<ArtifactRow, "content">>(
    `SELECT content FROM artifact
     WHERE id = $1 AND chat_session_id = $2`,
    [match[0], session.id],
  );
  if (!artifact) throw new NotFoundError("Artifact");
  return c.body(artifact.content, 200, { "Content-Type": "text/plain; charset=utf-8" });
});

// ---------------------------------------------------------------------------
// Output panel / workspace surfaces (no sandbox — faithful empty shapes)
// ---------------------------------------------------------------------------

/**
 * GET /sessions/:id/outputs — OutputInventory. complete:true marks the empty
 * inventory authoritative (compareOutputInventory then clears prior files).
 */
buildRoutes.get("/sessions/:id/outputs", requireAuth, async (c) => {
  const user = currentUser(c);
  await getOwnedSession(user.id, c.req.param("id"));
  return c.json({ files: [], complete: true });
});

/** GET /sessions/:id/output-cards — {cards: []} (OutputCard[] panel). */
buildRoutes.get("/sessions/:id/output-cards", requireAuth, async (c) => {
  const user = currentUser(c);
  await getOwnedSession(user.id, c.req.param("id"));
  return c.json({ cards: [] });
});

/** PATCH viewed markers — no cards exist; echo the empty card list. */
buildRoutes.patch("/sessions/:id/output-cards/viewed", requireAuth, async (c) => {
  const user = currentUser(c);
  await getOwnedSession(user.id, c.req.param("id"));
  return c.json({ cards: [] });
});

buildRoutes.patch("/sessions/:id/output-cards/:cardId/viewed", requireAuth, async (c) => {
  const user = currentUser(c);
  await getOwnedSession(user.id, c.req.param("id"));
  return c.json({ cards: [] });
});

/**
 * GET /sessions/:id/webapp-info — has_webapp:false reads as "no webapp"
 * everywhere (waitForWebappReady returns false immediately, BrowserTab shows
 * its empty state), so the no-sandbox port is always webapp-less.
 */
buildRoutes.get("/sessions/:id/webapp-info", requireAuth, async (c) => {
  const user = currentUser(c);
  await getOwnedSession(user.id, c.req.param("id"));
  return c.json({
    has_webapp: false,
    webapp_url: null,
    status: "not_started",
    ready: false,
    sharing_scope: "private" as const,
  });
});

/** GET /sessions/:id/files — DirectoryListing (empty workspace). */
buildRoutes.get("/sessions/:id/files", requireAuth, async (c) => {
  const user = currentUser(c);
  await getOwnedSession(user.id, c.req.param("id"));
  return c.json({ path: c.req.query("path") ?? "", entries: [] });
});

/**
 * POST /sessions/:id/upload — no sandbox filesystem exists to receive files;
 * surface an explicit 501 instead of a misleading 404 (attachments are
 * optional in the composer).
 */
buildRoutes.post("/sessions/:id/upload", requireAuth, async (c) => {
  const user = currentUser(c);
  await getOwnedSession(user.id, c.req.param("id"));
  throw new UnsupportedFeatureError(
    "Workspace uploads require the craft sandbox runtime, which is not part of this port",
  );
});

// ---------------------------------------------------------------------------
// Scheduled-run context (interactive sessions have no scheduled run)
// ---------------------------------------------------------------------------

buildRoutes.get("/sessions/:id/scheduled-run-context", requireAuth, async (c) => {
  const user = currentUser(c);
  await getOwnedSession(user.id, c.req.param("id"));
  throw new NotFoundError("Scheduled run");
});

// ---------------------------------------------------------------------------
// Approvals (no external-app runtime — always empty)
// ---------------------------------------------------------------------------

/** GET /approvals/sessions/:sessionId/status — ApprovalStatusView[]. */
buildRoutes.get("/approvals/sessions/:sessionId/status", requireAuth, async (c) => {
  currentUser(c);
  // Faithful-empty fill-in: no external-app approval gate exists in this port,
  // so the session id is not validated/owned-checked here.
  return c.json([]);
});

/** GET /approvals/sessions/:sessionId — ApprovalListResponse. */
buildRoutes.get("/approvals/sessions/:sessionId", requireAuth, async (c) => {
  currentUser(c);
  return c.json({ items: [] });
});

buildRoutes.post("/approvals/:approvalId/decision", requireAuth, async (c) => {
  currentUser(c);
  throw new NotFoundError("Approval");
});

// ---------------------------------------------------------------------------
// Miscellaneous surfaces fetched on/around the craft pages
// ---------------------------------------------------------------------------

/** GET /user-library/tree — LibraryEntry[] (UserLibraryModal). */
buildRoutes.get("/user-library/tree", requireAuth, async (c) => {
  currentUser(c);
  return c.json([]);
});

/** GET /apps — ExternalAppUserResponse[] (BuildMessageList connect cards). */
buildRoutes.get("/apps", requireAuth, async (c) => {
  currentUser(c);
  return c.json([]);
});

/** GET /action-policies — AppActionPoliciesView[] (action-policy editors). */
buildRoutes.get("/action-policies", requireAuth, async (c) => {
  currentUser(c);
  return c.json([]);
});

/** GET /scheduled-tasks — ScheduledTaskListResponse (tasks page). */
buildRoutes.get("/scheduled-tasks", requireAuth, async (c) => {
  currentUser(c);
  return c.json({ items: [] });
});

buildRoutes.get("/scheduled-tasks/:taskId", requireAuth, async (c) => {
  currentUser(c);
  throw new NotFoundError("Scheduled task");
});

/** GET /scheduled-tasks/:taskId/runs — ScheduledRunListResponse. */
buildRoutes.get("/scheduled-tasks/:taskId/runs", requireAuth, async (c) => {
  currentUser(c);
  return c.json({ items: [], next_cursor: null });
});
