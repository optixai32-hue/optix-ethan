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
import { getTool, listTools } from "../../tools/registry";
import { registerBuiltInTools } from "../../tools/built_in_tools";
import type { ToolContext } from "../../tools/interface";
import { getAuthContext } from "./chat";
import { catalogMcpToolSnapshots } from "./mcp_catalog_view";

const logger = getLogger("routes.tools");

try {
  registerBuiltInTools();
} catch (err) {
  logger.warning("built-in tool registration failed", { error: String(err) });
}

export const toolsRoutes = new Hono();

// ---------------------------------------------------------------------------
// v5.1.3 frontend-compatible tool identity.
//
// The frontend identifies built-in tools by the upstream class-name
// in_code_tool_id values and run_* names (web/src/app/app/services/actionUtils.ts:
//   isSearchTool       -> in_code_tool_id === "SearchTool" || name === "run_search"
//   isWebSearchTool    -> in_code_tool_id === "WebSearchTool"
//   isImageGeneration  -> in_code_tool_id === "ImageGenerationTool"
// plus backend/onyx/tools/constants.py SEARCH_TOOL_NAME = "run_search",
// INTERNET_SEARCH_TOOL_NAME = "run_internet_search",
// IMAGE_GENERATION_TOOL_NAME = "run_image_generation").
// The internal registry keeps its legacy ids (search_internal / web_search /
// generate_image) for the chat tool loop; the user-facing surfaces below
// translate them to the upstream identity.
// ---------------------------------------------------------------------------

interface FrontendToolIdentity {
  name: string;
  inCodeToolId: string;
  displayName: string;
}

const FRONTEND_TOOL_IDENTITY: Record<string, FrontendToolIdentity> = {
  search_internal: {
    name: "run_search",
    inCodeToolId: "SearchTool",
    displayName: "Search tool",
  },
  web_search: {
    name: "run_internet_search",
    inCodeToolId: "WebSearchTool",
    displayName: "Web Search",
  },
  generate_image: {
    name: "run_image_generation",
    inCodeToolId: "ImageGenerationTool",
    displayName: "Image Generation",
  },
};

function frontendIdentity(internalName: string): FrontendToolIdentity {
  return (
    FRONTEND_TOOL_IDENTITY[internalName] ?? {
      name: internalName,
      inCodeToolId: internalName,
      displayName: internalName,
    }
  );
}

/**
 * ToolSnapshot rows stamped onto personas / surfaced to the frontend.
 *
 * Visibility mirrors upstream ToolVisibilitySettings defaults
 * (server/features/tool/tool_visibility.py): built-in tools are
 * chat_selectable=True so they list inside the chat "Manage actions"
 * popover (cloud.onyx.app parity). Upstream only carves out OpenURLTool /
 * OktaProfileTool / MemoryTool — none of which exist in this port's
 * registry, so every registered built-in stays selectable.
 */
export function builtinToolSnapshots(): Record<string, unknown>[] {
  const builtIn = listTools().map((t, index) => {
    const identity = frontendIdentity(t.name);
    return {
      id: index + 1,
      name: identity.name,
      description: t.description,
      definition: t.inputSchema as Record<string, unknown> | null,
      display_name: identity.displayName,
      in_code_tool_id: identity.inCodeToolId,
      custom_headers: null,
      passthrough_auth: false,
      mcp_server_id: null,
      user_id: null,
      oauth_config_id: null,
      oauth_config_name: null,
      enabled: true,
      chat_selectable: true,
      agent_creation_selectable: true,
      default_enabled: true,
      user_enabled_in_chat: true,
      default_chat_enabled: true,
      permissions: {},
    };
  });
  // Catalog MCP tool rows — make the Plugins popover list the cloud-parity
  // catalog (chatPluginsForAgent requires agent tools with mcp_server_id).
  return [...builtIn, ...catalogMcpToolSnapshots()];
}

// GET /tool — port of GET /tool (server/features/tool/api.py): bare
// list[ToolSnapshot] (server/features/tool/models.py:32). The registry's
// built-in tools map to snapshots; enabled for chat by default.
toolsRoutes.get("/", async (c) => {
  try {
    await getAuthContext(c);
  } catch {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  return c.json(builtinToolSnapshots());
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
