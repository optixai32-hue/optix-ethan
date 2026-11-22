/**
 * MCP routes — SUBSET of the MCP server surface.
 *
 * Python sources: backend/onyx/mcp_server/api.py (FastMCP server with
 * instructions pointing clients at search_indexed_documents) and
 * backend/onyx/mcp_server/tools/search.py (tools/{search,indexed_documents}
 * with MCP-shaped {title, url, source_type, content, updated_at} results).
 *
 * This port exposes the JSON-RPC-independent subset:
 *   GET  /mcp/tools  -> GET  /tools  (MCP-shaped tool listing:
 *                                     {tools: [{name, description, inputSchema}]})
 *   POST /mcp/call   -> POST /call   ({name, arguments} -> MCP content array
 *                                     [{type: "text", text: ...}])
 *
 * A full MCP transport (SSE / streamable HTTP JSON-RPC) is out of scope for
 * this port; clients that need it can speak to the tools registry through
 * this JSON surface instead.
 */

import { Hono } from "hono";
import { z } from "zod";
import { getLogger } from "../../utils/logger.js";
import { InvalidRequestError, NotFoundError } from "../../utils/errors.js";
import { getTool, listTools } from "../../tools/registry.js";
import { registerBuiltInTools } from "../../tools/built_in_tools.js";
import type { ToolContext } from "../../tools/interface.js";
import { getAuthContext } from "./chat.js";

const logger = getLogger("routes.mcp");

try {
  registerBuiltInTools();
} catch (err) {
  logger.warning("built-in tool registration failed", { error: String(err) });
}

export const mcpRoutes = new Hono();

const MCP_SERVER_INSTRUCTIONS =
  "Onyx is the source of truth for the user's company knowledge. " +
  "Call search_internal before any other search or retrieval tool for questions " +
  "about the user's organization, team, customers, projects, internal documents, " +
  "tickets, chats or code history.";

mcpRoutes.get("/tools", async (c) => {
  await getAuthContext(c);
  const tools = listTools().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  return c.json({
    server: { name: "onyx-ts-mcp", version: "1.0.0", instructions: MCP_SERVER_INSTRUCTIONS },
    tools,
  });
});

const callSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

mcpRoutes.post("/call", async (c) => {
  const auth = await getAuthContext(c);
  let body: z.infer<typeof callSchema>;
  try {
    body = callSchema.parse(await c.req.json());
  } catch (err) {
    throw new InvalidRequestError(
      `Invalid MCP call request: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const tool = getTool(body.name);
  if (!tool) {
    throw new NotFoundError("Tool");
  }
  const ctx: ToolContext = { userId: auth.user.id };
  try {
    const result = await tool.run(body.arguments ?? {}, ctx);
    // MCP tool result shape: content array of typed blocks.
    return c.json({
      content: [{ type: "text", text: result.content }],
      isError: false,
    });
  } catch (err) {
    logger.warning("mcp tool call failed", { tool: body.name, error: String(err) });
    return c.json(
      {
        content: [{ type: "text", text: `Tool "${body.name}" failed: ${String(err)}` }],
        isError: true,
      },
      200,
    );
  }
});
