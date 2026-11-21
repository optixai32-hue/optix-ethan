/**
 * ToolSnapshot serialization — shared by GET /tool and the persona snapshots
 * (MinimalPersonaSnapshot.tools). Port of
 * backend/onyx/server/features/tool/models.py ToolSnapshot (30-85).
 */

import { listTools } from "./registry";
import type { Tool } from "./interface";

export function buildToolSnapshots(): Array<Record<string, unknown>> {
  return listTools().map((t, index) => ({
    id: index + 1,
    name: t.name,
    description: t.description,
    definition: t.inputSchema as Record<string, unknown> | null,
    display_name: t.displayName ?? t.name,
    // Upstream in-code id (onyx/tools/constants.py): the frontend's tool
    // gating (ToolsPopover, Deep Research toggle, built-in tool icons) keys
    // on these exact values.
    in_code_tool_id: t.inCodeToolId ?? t.name,
    custom_headers: null,
    passthrough_auth: false,
    mcp_server_id: null,
    user_id: null,
    oauth_config_id: null,
    oauth_config_name: null,
    enabled: true,
    user_enabled_in_chat: true,
    // ToolSnapshot booleans (server/features/tool/models.py:30-85) — falsy
    // `undefined` makes the ToolsPopover filter drop the tool entirely.
    chat_selectable: true,
    agent_creation_selectable: true,
    default_enabled: true,
    default_chat_enabled: true,
    permissions: {},
  }));
}
