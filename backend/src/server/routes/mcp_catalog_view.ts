/**
 * Catalog-backed MCP server views — renders src/configs/mcp_catalog.ts
 * entries as MCPServer rows for the member/admin plugin surfaces.
 *
 * Every catalog entry is exposed as a CONNECTED server: connection_status
 * "connected" so the chat input never renders the "Tools need credentials"
 * banner (the user-facing requirement: the catalog is a showcase, not a
 * connection checklist). The catalog still makes the Plugins page and the
 * chat plugins popover show the cloud catalog.
 */

import {
  MCP_PLUGIN_CATALOG,
  catalogServerId,
  type CatalogMcpServer,
} from "../../configs/mcp_catalog";

function authType(entry: CatalogMcpServer): string {
  if (entry.auth === "oauth") return "OAUTH";
  if (entry.auth === "credentials") return "API_TOKEN";
  return "NONE";
}

export function catalogMcpServers(): Record<string, unknown>[] {
  return MCP_PLUGIN_CATALOG.map((entry, index) => ({
    id: catalogServerId(index),
    name: entry.name,
    description: entry.description,
    server_url: entry.server_url,
    owner: null,
    transport: "STREAMABLE_HTTP",
    auth_type: authType(entry),
    auth_performer: entry.auth === "none" ? "ADMIN" : "PER_USER",
    oauth_provider_mode:
      entry.auth === "oauth" ? "KNOWN_PROVIDER" : "AUTO_DISCOVERY",
    oauth_setup_mode: entry.auth === "oauth" ? "automatic" : null,
    oauth_cimd_enabled: false,
    oauth_authorization_endpoint: entry.oauth_authorization_endpoint ?? null,
    oauth_token_endpoint: null,
    oauth_scopes_override: entry.oauth_scopes ?? null,
    oauth_additional_auth_params: {},
    connection_status: "connected",
    craft_connected: true,
    auth_template: entry.required_fields
      ? {
          headers: entry.headers ?? {},
          required_fields: entry.required_fields,
        }
      : null,
    admin_credentials: null,
    user_credentials: null,
    status: entry.auth === "none" ? "CREATED" : "AWAITING_AUTH",
    is_public: true,
    groups: [],
    users: [],
    available_in_craft: true,
    default_chat_enabled: true,
    user_enabled_in_chat: true,
    user_enabled_in_craft: true,
    action_policies: null,
    users_can_manage_policies: false,
    last_refreshed_at: null,
    tool_count: 0,
    permissions: {
      edit: true,
      view: true,
      delete: true,
    },
    // Catalog extras (frontend passes through unknown fields harmlessly).
    catalog_category: entry.category,
  }));
}

/**
 * Synthetic ToolSnapshot rows for the catalog — cloud parity for the chat
 * Plugins popover. On cloud.onyx.app every connected MCP server contributes
 * live tool rows (tools.mcp_server_id === server.id); the chat plugins list
 * (web/src/lib/plugins/chat.ts chatPluginsForAgent) only surfaces plugins
 * that have such tool rows on the active agent. This port has no remote MCP
 * client, so we mint one representative tool per catalog server (chat
 * selectable, enabled, mcp_server_id bound) so the Plugins row lists the
 * full catalog exactly like cloud. Execution degrades gracefully: the chat
 * tool loop answers "unknown tool" for registry misses (process_message.ts),
 * matching the documented no-op connect behavior.
 */
export function catalogMcpToolSnapshots(): Record<string, unknown>[] {
  return MCP_PLUGIN_CATALOG.map((entry, index) => {
    const serverId = catalogServerId(index);
    const slug = entry.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return {
      id: 5000 + index,
      name: `${slug}_mcp`,
      description: entry.description,
      definition: null,
      display_name: entry.name,
      custom_headers: null,
      in_code_tool_id: null,
      passthrough_auth: false,
      mcp_server_id: serverId,
      user_id: null,
      oauth_config_id: null,
      oauth_config_name: null,
      enabled: true,
      chat_selectable: true,
      agent_creation_selectable: true,
      default_enabled: false,
      user_enabled_in_chat: true,
      default_chat_enabled: true,
      permissions: {},
    };
  });
}
