/**
 * Owned by Task 2-d. Artifact REST routes — port of the craft artifact surface.
 *
 * Python sources consulted:
 *   - /home/z/onyx/backend/onyx/server/features/build/session/api.py
 *     (artifact endpoints: GET /{session_id}/artifacts lists a session's
 *      artifacts with BASIC_ACCESS permission; download_artifact serves a
 *      specific artifact; NOT_FOUND for foreign sessions)
 *   - /home/z/onyx/backend/onyx/server/features/build/session/manager.py
 *     (SessionManager artifact operations)
 *
 * Route shapes (spec): GET / (list; ?chat_session_id= scopes to a session),
 * POST / (create), GET /:id, PATCH /:id (update), DELETE /:id — all backed by
 * craft/artifacts.ts which enforces the chat-session ownership model. Auth
 * uses the local minimal session-cookie check shared with the connectors
 * routes (task 2-a owns the future auth/middleware.js).
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  createArtifact,
  deleteArtifact,
  getArtifact,
  listArtifacts,
  updateArtifact,
  type ArtifactPatch,
} from "../../craft/artifacts";
import { getLLMProvider } from "../../llm/factory";
import { InvalidRequestError } from "../../utils/errors";
import { getLogger } from "../../utils/logger";
import { requireUser } from "./connectors";

const logger = getLogger("server.routes.artifacts");

export const artifactsRoutes = new Hono();

const artifactCreateSchema = z.object({
  chat_session_id: z.string().uuid().optional(),
  title: z.string().min(1),
  content: z.string(),
});

const artifactPatchSchema = z
  .object({
    title: z.string().min(1).optional(),
    content: z.string().optional(),
  })
  .refine((patch) => patch.title !== undefined || patch.content !== undefined, {
    message: "at least one of title/content is required",
  });

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

/** List artifacts visible to the caller; ?chat_session_id scopes the list. */
artifactsRoutes.get("/", async (c) => {
  const user = await requireUser(c);
  const chatSessionId = c.req.query("chat_session_id");
  const artifacts = await listArtifacts(user.id, chatSessionId);
  return c.json({ artifacts });
});

/** Create an artifact (port of the build-session artifact creation). */
artifactsRoutes.post("/", async (c) => {
  const user = await requireUser(c);
  const body = parseBody(artifactCreateSchema.safeParse(await c.req.json()));
  const artifact = await createArtifact(user.id, {
    chatSessionId: body.chat_session_id,
    title: body.title,
    content: body.content,
  });
  logger.info("artifact created via API", { artifactId: artifact.id, userId: user.id });
  return c.json(artifact, 201);
});

artifactsRoutes.get("/:id", async (c) => {
  const user = await requireUser(c);
  const artifact = await getArtifact(user.id, c.req.param("id"));
  return c.json(artifact);
});

artifactsRoutes.patch("/:id", async (c) => {
  const user = await requireUser(c);
  const patch = parseBody<ArtifactPatch>(artifactPatchSchema.safeParse(await c.req.json()));
  const artifact = await updateArtifact(user.id, c.req.param("id"), patch);
  return c.json(artifact);
});

artifactsRoutes.delete("/:id", async (c) => {
  const user = await requireUser(c);
  const deleted = await deleteArtifact(user.id, c.req.param("id"));
  return c.json({ deleted });
});

const translateSchema = z.object({
  content: z.string().min(1).max(60_000),
  language: z.string().min(1).max(80),
});

/**
 * Translate a canvas document (the Deep Search canvas panel's Traduire
 * action). Pure text-in/text-out: the caller keeps ownership of the
 * original (translation lives in the panel state, the artifact is not
 * overwritten).
 */
artifactsRoutes.post("/translate", async (c) => {
  const _user = await requireUser(c);
  const body = parseBody(translateSchema.safeParse(await c.req.json()));

  const provider = await getLLMProvider();
  const translated = await provider.complete(
    [
      {
        role: "system",
        content: [
          "You are a professional document translator.",
          "Translate the provided markdown document into the target language.",
          "Preserve the markdown structure EXACTLY: heading levels, numbered and bulleted lists, bold and italic markers, tables (same columns and rows order), links (translate their visible text but keep the URLs unchanged), and citation markers like [1], [2] as-is.",
          "Translate naturally for a native reader of the target language; keep proper nouns, brand names, and model/product names in their usual form.",
          "Output ONLY the translated markdown document — no commentary, no fences, no explanation before or after.",
        ].join("\n"),
      },
      {
        role: "user",
        content: `Target language: ${body.language}\n\nDocument to translate:\n\n${body.content}`,
      },
    ],
    { maxTokens: 12_000 },
  );

  const content = (translated.content ?? "").trim();
  if (!content) {
    throw new InvalidRequestError("translation produced no content");
  }
  return c.json({ content });
});
