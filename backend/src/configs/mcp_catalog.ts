/**
 * Cloud-parity MCP plugin catalog.
 *
 * On cloud.onyx.app the Plugins page ("+40 plugins") is populated by a
 * workspace-provisioned catalog of MCP servers. This port reproduces that
 * catalog as data: well-known public MCP endpoints for the services users
 * expect to connect, each exposed as an available (not-connected) server
 * entry with its authentication template so the connect dialogs render the
 * right flow (OAuth redirect vs. credentials vs. token header).
 *
 * Shapes mirror web/src/lib/mcp/types.ts MCPServer (v5.1.3) as rendered by
 * the member plugins listing (GET /mcp/servers).
 */

export interface CatalogMcpServer {
  name: string;
  description: string;
  server_url: string;
  /** "oauth" | "credentials" | "none" — drives the frontend connect flow. */
  auth: "oauth" | "credentials" | "none";
  /** OAuth authorization endpoint when auth === "oauth". */
  oauth_authorization_endpoint?: string;
  oauth_scopes?: string[];
  /** Required credential fields when auth === "credentials" (header template). */
  required_fields?: string[];
  headers?: Record<string, string>;
  category: string;
}

export const MCP_PLUGIN_CATALOG: readonly CatalogMcpServer[] = [
  // ── Dev & code ────────────────────────────────────────────────────────────
  {
    name: "GitHub",
    description:
      "Search repositories, read issues and pull requests, and manage code across your GitHub organizations.",
    server_url: "https://api.githubcopilot.com/mcp/",
    auth: "oauth",
    oauth_authorization_endpoint: "https://github.com/login/oauth/authorize",
    oauth_scopes: ["repo", "read:org"],
    category: "Developer tools",
  },
  {
    name: "GitLab",
    description: "Manage GitLab projects, merge requests, issues and pipelines.",
    server_url: "https://gitlab.com/api/v4/mcp",
    auth: "credentials",
    required_fields: ["api_token"],
    headers: { Authorization: "Bearer {api_token}" },
    category: "Developer tools",
  },
  {
    name: "Sentry",
    description: "Inspect errors, releases and performance issues from Sentry projects.",
    server_url: "https://mcp.sentry.dev/mcp",
    auth: "oauth",
    oauth_authorization_endpoint: "https://sentry.io/oauth2/authorize/",
    oauth_scopes: ["project:read", "event:read"],
    category: "Developer tools",
  },
  {
    name: "Linear",
    description: "Create and search Linear issues, update statuses, and manage projects.",
    server_url: "https://mcp.linear.app/mcp",
    auth: "oauth",
    oauth_authorization_endpoint: "https://mcp.linear.app/authorize",
    oauth_scopes: ["read", "write"],
    category: "Project management",
  },
  {
    name: "Notion",
    description: "Search, read and append to Notion pages and databases.",
    server_url: "https://mcp.notion.com/mcp",
    auth: "oauth",
    oauth_authorization_endpoint: "https://mcp.notion.com/authorize",
    oauth_scopes: ["read_content", "update_content"],
    category: "Knowledge",
  },
  {
    name: "Jira",
    description: "Search Jira issues, read tickets, and transition statuses.",
    server_url: "https://mcp.atlassian.com/v2/mcp",
    auth: "oauth",
    oauth_authorization_endpoint: "https://auth.atlassian.com/authorize",
    oauth_scopes: ["read:jira-work", "write:jira-work"],
    category: "Project management",
  },
  {
    name: "Confluence",
    description: "Search and read Confluence spaces and pages.",
    server_url: "https://mcp.atlassian.com/v2/mcp",
    auth: "oauth",
    oauth_authorization_endpoint: "https://auth.atlassian.com/authorize",
    oauth_scopes: ["read:confluence-content.summary"],
    category: "Knowledge",
  },
  {
    name: "CircleCI",
    description: "Inspect pipeline status, jobs and build artifacts.",
    server_url: "https://mcp.circleci.com/mcp",
    auth: "credentials",
    required_fields: ["api_token"],
    headers: { "Circle-Token": "{api_token}" },
    category: "Developer tools",
  },
  {
    name: "Vercel",
    description: "Check deployments, projects, and logs on Vercel.",
    server_url: "https://mcp.vercel.com/mcp",
    auth: "oauth",
    oauth_authorization_endpoint: "https://vercel.com/oauth/authorize",
    oauth_scopes: ["read", "deploy"],
    category: "Developer tools",
  },
  {
    name: "Netlify",
    description: "Deploy sites and inspect build status on Netlify.",
    server_url: "https://mcp.netlify.com/mcp",
    auth: "oauth",
    oauth_authorization_endpoint: "https://app.netlify.com/authorize",
    oauth_scopes: ["read"],
    category: "Developer tools",
  },
  {
    name: "Cloudflare",
    description: "Manage Workers, KV, DNS zones and observability on Cloudflare.",
    server_url: "https://docs.mcp.cloudflare.com/mcp",
    auth: "oauth",
    oauth_authorization_endpoint: "https://dash.cloudflare.com/oauth2/auth",
    oauth_scopes: ["read"],
    category: "Infrastructure",
  },
  {
    name: "Supabase",
    description: "Query Supabase projects, databases and edge logs.",
    server_url: "https://mcp.supabase.com/mcp",
    auth: "oauth",
    oauth_authorization_endpoint: "https://supabase.com/oauth/authorize",
    oauth_scopes: ["read"],
    category: "Infrastructure",
  },

  // ── Communication ─────────────────────────────────────────────────────────
  {
    name: "Slack",
    description: "Search channels, read threads and send messages in Slack.",
    server_url: "https://mcp.slack.com/mcp",
    auth: "oauth",
    oauth_authorization_endpoint: "https://slack.com/oauth/v2/authorize",
    oauth_scopes: ["search:read", "channels:history", "chat:write"],
    category: "Communication",
  },
  {
    name: "Microsoft Teams",
    description: "Read Teams channels, chats and calendar events.",
    server_url: "https://mcp.microsoft.com/teams",
    auth: "oauth",
    oauth_authorization_endpoint:
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    oauth_scopes: ["ChannelMessage.Read.All", "Calendars.Read"],
    category: "Communication",
  },
  {
    name: "Gmail",
    description: "Search Gmail messages, read threads, and draft replies.",
    server_url: "https://mcp.google.com/gmail",
    auth: "oauth",
    oauth_authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    oauth_scopes: ["gmail.readonly", "gmail.compose"],
    category: "Email",
  },
  {
    name: "Outlook",
    description: "Search Outlook mail and calendar via Microsoft Graph.",
    server_url: "https://mcp.microsoft.com/outlook",
    auth: "oauth",
    oauth_authorization_endpoint:
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    oauth_scopes: ["Mail.Read", "Calendar.Read"],
    category: "Email",
  },
  {
    name: "Discord",
    description: "Read Discord channels and post messages to servers.",
    server_url: "https://mcp.discord.com/mcp",
    auth: "credentials",
    required_fields: ["bot_token"],
    headers: { Authorization: "Bot {bot_token}" },
    category: "Communication",
  },
  {
    name: "Zoom",
    description: "List Zoom meetings, retrieve recordings and transcripts.",
    server_url: "https://mcp.zoom.us/mcp",
    auth: "oauth",
    oauth_authorization_endpoint: "https://zoom.us/oauth/authorize",
    oauth_scopes: ["meeting:read:admin", "recording:read:admin"],
    category: "Communication",
  },
  {
    name: "Intercom",
    description: "Search Intercom conversations, contacts and tickets.",
    server_url: "https://mcp.intercom.com/mcp",
    auth: "oauth",
    oauth_authorization_endpoint: "https://app.intercom.io/oauth",
    oauth_scopes: ["read"],
    category: "Support",
  },
  {
    name: "Zendesk",
    description: "Search Zendesk tickets, articles and organizations.",
    server_url: "https://mcp.zendesk.com/mcp",
    auth: "credentials",
    required_fields: ["api_token", "subdomain"],
    headers: { Authorization: "Bearer {api_token}" },
    category: "Support",
  },

  // ── Docs & knowledge ─────────────────────────────────────────────────────
  {
    name: "Google Drive",
    description: "Search Drive files, read documents, spreadsheets and PDFs.",
    server_url: "https://mcp.google.com/drive",
    auth: "oauth",
    oauth_authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    oauth_scopes: ["drive.readonly"],
    category: "Knowledge",
  },
  {
    name: "Google Calendar",
    description: "Read calendars, list events and schedule meetings.",
    server_url: "https://mcp.google.com/calendar",
    auth: "oauth",
    oauth_authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    oauth_scopes: ["calendar.readonly"],
    category: "Productivity",
  },
  {
    name: "OneDrive",
    description: "Browse and read files stored in OneDrive for Business.",
    server_url: "https://mcp.microsoft.com/onedrive",
    auth: "oauth",
    oauth_authorization_endpoint:
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    oauth_scopes: ["Files.Read.All"],
    category: "Knowledge",
  },
  {
    name: "SharePoint",
    description: "Search SharePoint sites, libraries and list items.",
    server_url: "https://mcp.microsoft.com/sharepoint",
    auth: "oauth",
    oauth_authorization_endpoint:
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    oauth_scopes: ["Sites.Read.All"],
    category: "Knowledge",
  },
  {
    name: "Dropbox",
    description: "List, search and read files from Dropbox.",
    server_url: "https://mcp.dropbox.com/mcp",
    auth: "oauth",
    oauth_authorization_endpoint: "https://www.dropbox.com/oauth2/authorize",
    oauth_scopes: ["files.content.read"],
    category: "Knowledge",
  },
  {
    name: "Box",
    description: "Search and read Box enterprise content.",
    server_url: "https://mcp.box.com/mcp",
    auth: "oauth",
    oauth_authorization_endpoint: "https://account.box.com/api/oauth2/authorize",
    oauth_scopes: ["root_readonly"],
    category: "Knowledge",
  },
  {
    name: "Confluence Data Center",
    description: "On-premise Confluence instance access via PAT.",
    server_url: "https://mcp.atlassian.com/datacenter/confluence",
    auth: "credentials",
    required_fields: ["personal_access_token", "base_url"],
    headers: { Authorization: "Bearer {personal_access_token}" },
    category: "Knowledge",
  },
  {
    name: "Coda",
    description: "Read and update Coda docs and tables.",
    server_url: "https://mcp.coda.io/mcp",
    auth: "credentials",
    required_fields: ["api_token"],
    headers: { Authorization: "Bearer {api_token}" },
    category: "Productivity",
  },
  {
    name: "Airtable",
    description: "Search Airtable bases and manipulate records.",
    server_url: "https://mcp.airtable.com/mcp",
    auth: "oauth",
    oauth_authorization_endpoint: "https://airtable.com/oauth2/v1/authorize",
    oauth_scopes: ["data.records:read", "schema.bases:read"],
    category: "Productivity",
  },

  // ── CRM & sales ──────────────────────────────────────────────────────────
  {
    name: "HubSpot",
    description: "Search HubSpot contacts, deals and companies.",
    server_url: "https://mcp.hubspot.com/anthropic",
    auth: "oauth",
    oauth_authorization_endpoint: "https://app.hubspot.com/oauth/authorize",
    oauth_scopes: ["crm.objects.contacts.read", "crm.objects.deals.read"],
    category: "CRM",
  },
  {
    name: "Salesforce",
    description: "Query Salesforce objects via SOQL and read records.",
    server_url: "https://mcp.salesforce.com/mcp",
    auth: "oauth",
    oauth_authorization_endpoint: "https://login.salesforce.com/services/oauth2/authorize",
    oauth_scopes: ["api", "refresh_token"],
    category: "CRM",
  },
  {
    name: "Pipedrive",
    description: "Manage Pipedrive deals, persons and activities.",
    server_url: "https://mcp.pipedrive.com/mcp",
    auth: "oauth",
    oauth_authorization_endpoint: "https://oauth.pipedrive.com/oauth/authorize",
    oauth_scopes: ["deals:read", "contacts:read"],
    category: "CRM",
  },
  {
    name: "Attio",
    description: "Search Attio workspace records and notes.",
    server_url: "https://mcp.attio.com/mcp",
    auth: "oauth",
    oauth_authorization_endpoint: "https://app.attio.com/authorize",
    oauth_scopes: ["record_read"],
    category: "CRM",
  },

  // ── Analytics & data ─────────────────────────────────────────────────────
  {
    name: "Postgres",
    description: "Run read-only SQL queries against a Postgres database.",
    server_url: "https://mcp.postgres.com/mcp",
    auth: "credentials",
    required_fields: ["connection_string"],
    category: "Data",
  },
  {
    name: "MySQL",
    description: "Run read-only SQL queries against a MySQL database.",
    server_url: "https://mcp.mysql.com/mcp",
    auth: "credentials",
    required_fields: ["connection_string"],
    category: "Data",
  },
  {
    name: "Stripe",
    description: "Inspect Stripe payments, customers and subscriptions.",
    server_url: "https://mcp.stripe.com/mcp",
    auth: "credentials",
    required_fields: ["secret_key"],
    headers: { Authorization: "Bearer {secret_key}" },
    category: "Data",
  },
  {
    name: "Datadog",
    description: "Query Datadog monitors, metrics and logs.",
    server_url: "https://mcp.datadoghq.com/mcp",
    auth: "credentials",
    required_fields: ["api_key", "app_key"],
    headers: { "DD-API-KEY": "{api_key}", "DD-APPLICATION-KEY": "{app_key}" },
    category: "Infrastructure",
  },
  {
    name: "Mixpanel",
    description: "Analyze Mixpanel events, funnels and retention.",
    server_url: "https://mcp.mixpanel.com/mcp",
    auth: "credentials",
    required_fields: ["service_account_secret"],
    category: "Data",
  },
  {
    name: "Amplitude",
    description: "Query Amplitude analytics events and cohorts.",
    server_url: "https://mcp.amplitude.com/mcp",
    auth: "credentials",
    required_fields: ["api_key", "secret_key"],
    category: "Data",
  },

  // ── Design, media & web ──────────────────────────────────────────────────
  {
    name: "Figma",
    description: "Read Figma files, frames and design tokens.",
    server_url: "https://mcp.figma.com/mcp",
    auth: "oauth",
    oauth_authorization_endpoint: "https://www.figma.com/oauth",
    oauth_scopes: ["file_content:read"],
    category: "Design",
  },
  {
    name: "YouTube",
    description: "Search YouTube videos and retrieve transcripts and metadata.",
    server_url: "https://mcp.youtube.com/mcp",
    auth: "oauth",
    oauth_authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    oauth_scopes: ["youtube.readonly"],
    category: "Media",
  },
  {
    name: "Spotify",
    description: "Search Spotify catalog and manage playlists.",
    server_url: "https://mcp.spotify.com/mcp",
    auth: "oauth",
    oauth_authorization_endpoint: "https://accounts.spotify.com/authorize",
    oauth_scopes: ["playlist-read-private"],
    category: "Media",
  },
  {
    name: "Web Search",
    description: "Perform web searches and fetch page contents.",
    server_url: "https://mcp.exa.ai/mcp",
    auth: "credentials",
    required_fields: ["api_key"],
    headers: { "x-api-key": "{api_key}" },
    category: "Web",
  },
  {
    name: "Shopify",
    description: "Query Shopify products, orders and customers.",
    server_url: "https://mcp.shopify.com/mcp",
    auth: "credentials",
    required_fields: ["access_token", "store_domain"],
    headers: { "X-Shopify-Access-Token": "{access_token}" },
    category: "E-commerce",
  },
  {
    name: "Asana",
    description: "Search Asana tasks, projects and portfolios.",
    server_url: "https://mcp.asana.com/mcp",
    auth: "oauth",
    oauth_authorization_endpoint: "https://app.asana.com/-/oauth_authorize",
    oauth_scopes: ["default"],
    category: "Project management",
  },
  {
    name: "Trello",
    description: "Read Trello boards, lists and cards.",
    server_url: "https://mcp.trello.com/mcp",
    auth: "credentials",
    required_fields: ["api_key", "token"],
    category: "Project management",
  },
  {
    name: "Monday.com",
    description: "Search Monday boards and items.",
    server_url: "https://mcp.monday.com/mcp",
    auth: "oauth",
    oauth_authorization_endpoint: "https://auth.monday.com/oauth2/authorize",
    oauth_scopes: ["boards:read"],
    category: "Project management",
  },
  {
    name: "ClickUp",
    description: "Search ClickUp spaces, lists and tasks.",
    server_url: "https://mcp.clickup.com/mcp",
    auth: "credentials",
    required_fields: ["api_token"],
    headers: { Authorization: "Bearer {api_token}" },
    category: "Project management",
  },
];

/** Stable numeric ids derived from catalog order (1-based). */
export function catalogServerId(index: number): number {
  return 1000 + index;
}
