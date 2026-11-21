/**
 * Tools routes — TypeScript port of the tool listing / invocation surface
 * (backend/onyx/server/api/tools.py tool listing + the Tool
 * definition/tool-run shapes from backend/onyx/tools/interface.py
 * tool_definition_from_arguments).
 *
 *   GET  /tools             -> GET  /          (registry listing with
 *                                               name/description/schema)
 *   POST /tools/{id}/run    -> POST /:id/run   (dev/test invocation {input})
 *
 * Auth resolution is shared with the chat routes (canonical surface owned by
 * Task 2-a; see server/routes/chat.ts getAuthContext).
 */

import { Hono } from "hono";
import { z } from "zod";
import { getLogger } from "../../utils/logger";
import { InvalidRequestError, NotFoundError } from "../../utils/errors";
import { getTool } from "../../tools/registry";
import { buildToolSnapshots } from "../../tools/snapshot";
import { registerBuiltInTools } from "../../tools/built_in_tools";
import type { ToolContext } from "../../tools/interface";
import { getAuthContext } from "./chat";

const logger = getLogger("routes.tools");

try {
  registerBuiltInTools();
} catch (err) {
  logger.warning("built-in tool registration failed", { error: String(err) });
}

export const toolsRoutes = new Hono();

// GET /tool — port of GET /tool (server/features/tool/api.py): bare
// list[ToolSnapshot] (server/features/tool/models.py:32). The registry's
// built-in tools map to snapshots; enabled for chat by default.
toolsRoutes.get("/", async (c) => {
  try {
    await getAuthContext(c);
  } catch {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  const tools = buildToolSnapshots();
  return c.json(tools);
});

const runToolSchema = z.object({
  input: z.record(z.string(), z.unknown()).optional(),
});

toolsRoutes.post("/:id/run", async (c) => {
  const auth = await getAuthContext(c);
  const toolId = c.req.param("id");
  const tool = getTool(toolId);
  if (!tool) {
    throw new NotFoundError("Tool");
  }
  let body: z.infer<typeof runToolSchema>;
  try {
    body = runToolSchema.parse(await c.req.json());
  } catch (err) {
    throw new InvalidRequestError(
      `Invalid tool run request: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const ctx: ToolContext = { userId: auth.user.id };
  const result = await tool.run(body.input ?? {}, ctx);
  return c.json({ tool_id: tool.id, content: result.content });
});
