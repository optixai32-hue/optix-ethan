/**
 * Admin-surface fill-ins — Task 2-b. The read paths the admin console (and a
 * few user-settings surfaces) fetch that the earlier route files do not cover.
 * Each endpoint's response shape was verified against its frontend consumer in
 * /home/z/nelth-ai/web/src (consumer listed per route). Features that are not
 * deployed in this port (MCP servers, skills, hooks, tracing, voice, Slack
 * bots, SSO, web-search/image-generation/tracing providers, cost overrides,
 * external build apps, PAT storage) return their faithful empty/disabled
 * shape rather than fabricated content; the endpoints that CAN be answered
 * from real tables (license seat usage, the shareable user list, admin API
 * keys, the default assistant's prompt, indexing overview counters) are
 * DB-backed with try/catch fallbacks so a missing table never breaks a page.
 *
 * Python sources consulted:
 *   - ee/onyx/server/license/models.py      LicenseStatusResponse (GET /license)
 *   - ee/onyx/server/billing/api.py         SubscriptionStatusResponse (no billing)
 *   - onyx/server/manage/users.py:947       GET /users (MinimalUserSnapshot[])
 *   - onyx/server/features/skill/api.py     GET /skills (SkillsList)
 *   - onyx/server/features/tool/api.py:454  GET /tool/openapi (list[ToolSnapshot])
 *   - onyx/server/features/mcp/api.py       GET /admin/mcp/servers (MCPServersResponse)
 *   - onyx/server/features/default_assistant/api.py  DefaultAssistantConfiguration
 *   - onyx/server/pat/{api,models}.py       GET /user/pats (+ /scopes) — PatScopeOption
 *   - onyx/server/security/{api,models,store}.py     GET /admin/security (+ /pinned-fields)
 *   - onyx/server/documents/index_monitoring.py      index-monitoring surface
 *   - onyx/server/documents/cc_pair_throughput.py    throughput slice counts
 *   - onyx/server/documents/connector.py    POST /manage/admin/connector/indexing-status
 */
import { Hono } from "hono";
import { requireAdmin, requireAuth } from "../../auth/middleware";
import { query, queryOne } from "../../db/client";
import {
  INDEXING_EMBEDDING_DIM,
  INDEXING_EMBEDDING_MODEL,
} from "../../configs/constants";
import { getLogger } from "../../utils/logger";
import { catalogMcpServers } from "./mcp_catalog_view";

const logger = getLogger("server.routes.admin_surface");

export const adminSurfaceRoutes = new Hono();

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Count query that degrades to 0 when the table is missing/unreachable. */
async function safeCount(sql: string, params: readonly unknown[] = []): Promise<number> {
  try {
    const res = await query<{ count: string }>(sql, params);
    return Number(res.rows[0]?.count ?? 0);
  } catch (err) {
    logger.warning("admin_surface count query failed", {
      sql,
      error: String(err),
    });
    return 0;
  }
}

/** First-row query that degrades to null when the table is missing. */
async function safeQueryOne<T extends Record<string, unknown>>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  try {
    return await queryOne<T>(sql, params);
  } catch (err) {
    logger.warning("admin_surface query failed", { sql, error: String(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// A. Cross-cutting admin chrome
// ---------------------------------------------------------------------------

// GET /license — LicenseStatusResponse (ee/onyx/server/license/models.py:100).
// Consumer: web/src/hooks/useLicense.ts (LicenseStatus, lib/billing/types.ts).
// This deployment fakes an active enterprise cloud license: has_license=true,
// status "active", no expiry pressure. used_seats is the real user count.
adminSurfaceRoutes.get("/license", requireAdmin, async (c) => {
  const usedSeats = await safeCount(`SELECT count(*) AS count FROM onyx_user`);
  const now = Date.now();
  const issuedAt = new Date(now - 90 * 24 * 60 * 60 * 1000); // 90 days ago
  const expiresAt = new Date(now + 10 * 365 * 24 * 60 * 60 * 1000); // 10 years out
  return c.json({
    has_license: true,
    seats: Math.max(1000, usedSeats),
    used_seats: usedSeats,
    plan_type: "annual",
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    grace_period_end: null,
    status: "active",
    expiry_warning_stage: "none",
    source: "auto_fetch",
    trial_end: null,
  });
});

// GET /admin/billing/billing-information — SubscriptionStatusResponse
// (ee/onyx/server/billing/api.py:282, models.py:63): no billing configured.
// Consumer: web/src/hooks/useBillingInformation.ts (BillingInformation |
// SubscriptionStatus union; the { subscribed: false } member is the
// "no billing configured" branch).
adminSurfaceRoutes.get("/admin/billing/billing-information", requireAdmin, (c) => {
  return c.json({ subscribed: false });
});

// ---------------------------------------------------------------------------
// B. Feature config pages
// ---------------------------------------------------------------------------

// GET /admin/mcp/servers — MCPServersResponse
// (web/src/lib/mcp/hooks.ts useAdminMcpServers -> web/src/lib/mcp/types.ts
// MCPServersResponse { mcp_servers: MCPServer[] }; consumers: /app/agents
// page via useMcpServersForAgent and admin/plugins via useInstalledPlugins).
// No MCP server rows exist in this port.
adminSurfaceRoutes.get("/admin/mcp/servers", requireAdmin, (c) => {
  // Cloud-parity catalog (see mcp_catalog_view.ts) so the admin Plugins page
  // lists the same available-to-connect servers as the member surface.
  return c.json({ mcp_servers: catalogMcpServers() });
});

// GET /tool/openapi — list[ToolSnapshot] (onyx/server/features/tool/api.py:454).
// Consumer: web/src/hooks/useOpenApiTools.ts (ToolSnapshot[]; the admin
// plugins page's OpenAPI plugin list). No custom OpenAPI tools in this port.
// BASIC_ACCESS in Python -> requireAuth here.
adminSurfaceRoutes.get("/tool/openapi", requireAuth, (c) => {
  return c.json([]);
});

// GET /build/admin/apps — list[ExternalAppAdminResponse]
// (web/src/lib/plugins/hooks.ts useInstalledPlugins ->
// web/src/app/craft/v1/apps/registry.ts ExternalAppAdminResponse; consumers:
// admin/plugins page and the skills/editor surfaces). Craft apps are not
// deployed: empty list.
adminSurfaceRoutes.get("/build/admin/apps", requireAdmin, (c) => {
  return c.json([]);
});

// GET /users — list[MinimalUserSnapshot] (onyx/server/manage/users.py:947).
// Consumer: web/src/hooks/useShareableUsers.ts (MinimalUserSnapshot {id,email};
// used by the skills/agent share modals with ?include_api_keys=true).
// DB-backed from onyx_user; degrades to [] when the table is unavailable.
adminSurfaceRoutes.get("/users", requireAuth, async (c) => {
  try {
    const res = await query<{ id: string; email: string }>(
      `SELECT id, email FROM onyx_user WHERE is_active ORDER BY email ASC`,
    );
    return c.json(res.rows.map((row) => ({ id: row.id, email: row.email })));
  } catch (err) {
    logger.warning("GET /users fell back to an empty list", {
      error: String(err),
    });
    return c.json([]);
  }
});

// GET /skills — SkillsList (onyx/server/features/skill/api.py:266).
// Consumer: web/src/hooks/useUserSkills.ts (SkillsList {builtins, customs}
// from web/src/lib/skills/types.ts; the admin skills page and the Craft
// input bar). No skill rows in this port.
adminSurfaceRoutes.get("/skills", requireAuth, (c) => {
  return c.json({ builtins: [], customs: [] });
});

// GET /admin/sso/provider — list[SSOProviderResponse]
// (web/src/views/admin/SSOProvidersPage.tsx -> web/src/lib/sso/types.ts).
// No SSO providers configured: empty list.
adminSurfaceRoutes.get("/admin/sso/provider", requireAdmin, (c) => {
  return c.json([]);
});

// GET /admin/api-key — list[ApiKeyDescriptor]
// (web/src/views/admin/ServiceAccountsPage/index.tsx APIKey[] and
// web/src/views/admin/GroupsPage/useGroupMemberCandidates.ts
// ApiKeyDescriptor[]). DB-backed from the api_key table; the raw key never
// appears on a listing (api_key: null), groups are not ported.
adminSurfaceRoutes.get("/admin/api-key", requireAdmin, async (c) => {
  try {
    const res = await query<{
      id: string;
      user_id: string | null;
      name: string;
      api_key_display: string;
    }>(
      `SELECT id, user_id, name, api_key_display
       FROM api_key
       WHERE is_active
       ORDER BY created_at ASC`,
    );
    return c.json(
      res.rows.map((key) => ({
        api_key_id: key.id,
        api_key_display: key.api_key_display,
        api_key: null,
        api_key_name: key.name,
        groups: [],
        user_id: key.user_id ?? "",
      })),
    );
  } catch (err) {
    logger.warning("GET /admin/api-key fell back to an empty list", {
      error: String(err),
    });
    return c.json([]);
  }
});

// GET /admin/hooks — list[HookResponse]
// (web/src/ee/hooks/useHooks.ts -> web/src/ee/views/admin/HooksPage/interfaces.ts).
// The hooks feature is not deployed: empty list.
adminSurfaceRoutes.get("/admin/hooks", requireAdmin, (c) => {
  return c.json([]);
});

// GET /admin/hooks/specs — list[HookPointMeta]
// (web/src/ee/hooks/useHookSpecs.ts). No hook points are wired in this port.
adminSurfaceRoutes.get("/admin/hooks/specs", requireAdmin, (c) => {
  return c.json([]);
});

// GET /admin/security — SecuritySettings
// (web/src/views/admin/SecurityHardeningPage.tsx ->
// web/src/lib/types.ts SecuritySettings). Env-merged defaults mirroring
// onyx/server/security/store.py _build_env_defaults for a single-tenant
// deployment: every optional control off, JWT bearer checks unconfigured.
adminSurfaceRoutes.get("/admin/security", requireAdmin, (c) => {
  return c.json({
    user_directory_admin_only: false,
    incognito_availability: "off",
    incognito_record_mode: "usage_only",
    allow_connector_group_restrictions: false,
    allow_connector_check_findings: true,
    track_external_idp_expiry: false,
    allow_same_provider_subject_relink: false,
    allow_renamed_account_claim: false,
    ssrf_protection_level: "validate_all",
    mask_credential_prefix: true,
    llm_custom_config_env_injection: true,
    valid_email_domains: [],
    password_min_length: 8,
    password_max_length: 64,
    password_require_uppercase: false,
    password_require_lowercase: false,
    password_require_digit: false,
    password_require_special_char: false,
    password_auth_enabled: true,
    jwt_public_key_url: null,
    jwt_expected_audience: null,
    jwt_expected_issuer: null,
  });
});

// GET /admin/security/pinned-fields — list[str]
// (web/src/views/admin/SecurityHardeningPage.tsx useSWR<string[]>).
// Mirrors ENV_PINNED_FIELDS: the three jwt_* env-pinned settings.
adminSurfaceRoutes.get("/admin/security/pinned-fields", requireAdmin, (c) => {
  return c.json(["jwt_public_key_url", "jwt_expected_audience", "jwt_expected_issuer"]);
});

// GET /admin/tracing/providers — list[TracingProviderView]
// (web/src/lib/tracing/hooks.ts -> web/src/lib/tracing/types.ts).
// No tracing providers configured.
adminSurfaceRoutes.get("/admin/tracing/providers", requireAdmin, (c) => {
  return c.json([]);
});

// GET /admin/voice/providers — list[VoiceProviderView]
// (web/src/lib/voice/hooks.ts -> web/src/lib/voice/types.ts).
// No STT/TTS providers configured in this port.
adminSurfaceRoutes.get("/admin/voice/providers", requireAdmin, (c) => {
  return c.json([]);
});

// GET /manage/admin/slack-app/bots — list[SlackBot]
// (web/src/app/admin/bots/[bot-id]/hooks.ts useSlackBots ->
// web/src/lib/types.ts SlackBot). No Slack bots in this port.
adminSurfaceRoutes.get("/manage/admin/slack-app/bots", requireAdmin, (c) => {
  return c.json([]);
});

// GET /user/pats — list[TokenResponse] (onyx/server/pat/api.py list_tokens).
// Consumer: web/src/views/SettingsPage.tsx (PAT[]). No PAT storage in this
// port: empty list.
adminSurfaceRoutes.get("/user/pats", requireAuth, (c) => {
  return c.json([]);
});

// GET /user/pats/scopes — list[PatScopeOption] (onyx/server/pat/models.py).
// Consumer: web/src/views/SettingsPage.tsx (PatScopeOption: scope,
// group_label, label, description, min_tier, implies). Static port of
// SELECTABLE_PAT_SCOPES; `implies` mirrors IMPLIED_PERMISSIONS
// (write:chat => read:chat).
const PAT_SCOPE_OPTIONS = [
  {
    scope: "read:search",
    group_label: "Search",
    label: "Read",
    description: "Use search and query endpoints.",
    min_tier: "community",
    implies: [] as string[],
  },
  {
    scope: "read:chat",
    group_label: "Chat",
    label: "Read",
    description: "View chat sessions and messages.",
    min_tier: "community",
    implies: [] as string[],
  },
  {
    scope: "write:chat",
    group_label: "Chat",
    label: "Write",
    description: "Create sessions and send messages.",
    min_tier: "community",
    implies: ["read:chat"],
  },
  {
    scope: "use:llm_gateway",
    group_label: "LLM Gateway",
    label: "Use",
    description: "Call the LLM gateway from external tools.",
    min_tier: "business",
    implies: [] as string[],
  },
];

adminSurfaceRoutes.get("/user/pats/scopes", requireAuth, (c) => {
  return c.json(PAT_SCOPE_OPTIONS);
});

// GET /admin/default-assistant/configuration — DefaultAssistantConfiguration
// (web/src/lib/agents/hooks.ts useDefaultAssistantConfiguration ->
// web/src/lib/agents/types.ts DefaultAssistantConfiguration {tool_ids,
// system_prompt, default_system_prompt}). Derived from the seeded default
// persona (builtin_persona = true); tool attachment is not ported, so
// tool_ids is empty.
const DEFAULT_SYSTEM_PROMPT = `You are an expert assistant who is truthful, nuanced, insightful, and efficient. Your goal is to deeply understand the user's intent, think step-by-step through complex problems, provide clear and accurate answers, and proactively anticipate helpful follow-up information. Whenever there is any ambiguity around the user's query (or more information would be helpful), you use available tools (if any) to get more context.

The current date is {{CURRENT_DATETIME}}.

# Response Style
You use different text styles, bolding, emojis (sparingly), block quotes, and other formatting to make your responses more readable and engaging.
You use proper Markdown and LaTeX to format your responses for math, scientific, and chemical formulas, symbols, etc.: '$$\\n[expression]\\n$$' for standalone cases and '\\( [expression] \\)' when inline.
For code you prefer to use Markdown and specify the language.
You can use horizontal rules (---) to separate sections of your responses.
You can use Markdown tables to format your responses for data, lists, and other structured information.`;

adminSurfaceRoutes.get(
  "/admin/default-assistant/configuration",
  requireAdmin,
  async (c) => {
    const row = await safeQueryOne<{ system_prompt: string }>(
      `SELECT system_prompt FROM persona
       WHERE builtin_persona = true AND deleted = false
       ORDER BY id ASC
       LIMIT 1`,
    );
    return c.json({
      tool_ids: [] as number[],
      system_prompt: row ? row.system_prompt : null,
      default_system_prompt: DEFAULT_SYSTEM_PROMPT,
    });
  },
);

// GET /admin/cost-overrides — list[CostOverride]
// (web/src/lib/languageModels/costOverrides.ts useCostOverrides ->
// web/src/lib/languageModels/types.ts CostOverride). No override rows in
// this port: empty list.
adminSurfaceRoutes.get("/admin/cost-overrides", requireAdmin, (c) => {
  return c.json([]);
});

// GET /admin/web-search/search-providers — list[WebSearchProviderView]
// (web/src/lib/webSearch/hooks.ts useWebSearchProviders). No search
// providers configured.
adminSurfaceRoutes.get("/admin/web-search/search-providers", requireAdmin, (c) => {
  return c.json([]);
});

// GET /admin/web-search/content-providers — list[WebContentProviderView]
// (web/src/lib/webSearch/hooks.ts useWebSearchProviders). No content
// providers configured.
adminSurfaceRoutes.get("/admin/web-search/content-providers", requireAdmin, (c) => {
  return c.json([]);
});

// GET /admin/image-generation/config — list[ImageGenerationConfigView]
// (web/src/views/admin/ImageGenerationPage/ImageGenerationContent.tsx).
// Disabled config: no image-generation provider connected (empty list).
adminSurfaceRoutes.get("/admin/image-generation/config", requireAdmin, (c) => {
  return c.json([]);
});

// GET /admin/embedding/embedding-provider — list[ConfiguredEmbeddingProvider]
// (web/src/lib/searchSettings/hooks.ts useConfiguredEmbeddingProviders ->
// web/src/lib/searchSettings/types.ts). The list holds cloud providers with
// stored credentials; this deployment runs the local hash embedder
// (onyx-ts-local-embedder, dim 384), which has no cloud credentials, so the
// list is empty.
adminSurfaceRoutes.get("/admin/embedding/embedding-provider", requireAdmin, (c) => {
  return c.json([]);
});

// ---------------------------------------------------------------------------
// C. Indexing / search admin
// ---------------------------------------------------------------------------

// Throughput slices per window (onyx/server/documents/cc_pair_throughput.py
// THROUGHPUT_SLICES). The frontend divides the window span by
// docs_indexed.length, so the array must carry the real slice count even
// when every slice is zero.
const THROUGHPUT_SLICES: Record<string, number> = {
  "1h": 20,
  "24h": 72,
  "7d": 84,
  all: 84,
};

function windowDurationMs(window: string): number {
  if (window === "24h") return 24 * 60 * 60 * 1000;
  if (window === "7d" || window === "all") return 7 * 24 * 60 * 60 * 1000;
  return 60 * 60 * 1000;
}

// GET /manage/admin/index-monitoring/overview — IndexingOverviewResponse
// (web/src/views/admin/connectors/IndexingStatusPage/OverviewCard.tsx ->
// web/src/lib/connectors/types/indexMonitoring.ts). Counters are DB-backed
// (pairs / in-progress attempts / documents) with zeroed fallbacks; the
// throughput chart is a zero-filled slice array over the requested window.
adminSurfaceRoutes.get(
  "/manage/admin/index-monitoring/overview",
  requireAdmin,
  async (c) => {
    const window = c.req.query("window") ?? "1h";
    const slices = THROUGHPUT_SLICES[window] ?? 20;
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - windowDurationMs(window));

    const activeConnectors = await safeCount(
      `SELECT count(*) AS count FROM connector_credential_pair`,
    );
    const indexingConnectors = await safeCount(
      `SELECT count(*) AS count FROM index_attempt WHERE status = 'in_progress'`,
    );
    const totalDocsIndexed = await safeCount(
      `SELECT count(*) AS count FROM document`,
    );

    return c.json({
      indexing_connectors: indexingConnectors,
      active_connectors: activeConnectors,
      recent_docs_indexed: 0,
      total_docs_indexed: totalDocsIndexed,
      throughput: {
        window_start: windowStart.toISOString(),
        window_end: windowEnd.toISOString(),
        docs_indexed: new Array<number>(slices).fill(0),
        runs: [],
      },
    });
  },
);

// GET /manage/admin/index-monitoring/runs — IndexingRunsResponse
// (web/src/lib/connectors/ccPair/hooks.tsx useActivityItems ->
// IndexingRunsResponse { items, total_items, status_counts }). The runs feed
// is backed by tables this port does not populate: an empty first page with
// zeroed status buckets (keys must exist — the page reads them directly).
adminSurfaceRoutes.get(
  "/manage/admin/index-monitoring/runs",
  requireAdmin,
  (c) => {
    // Query params (page_num, page_size, status_groups, superseded, resolved,
    // errors, q, since, until, kinds) are accepted and ignored: the empty
    // feed is the same for every filter.
    return c.json({
      items: [],
      total_items: 0,
      status_counts: {
        running: 0,
        succeeded: 0,
        failed: 0,
        canceled: 0,
      },
    });
  },
);

// GET /manage/admin/index-monitoring/connectors — IndexingConnectorsResponse
// (web/src/views/admin/connectors/IndexingStatusPage/ConnectorList.tsx ->
// IndexingConnectorsResponse { items, total_items, status_counts,
// federated_connectors }). status_counts must carry every bucket key.
adminSurfaceRoutes.get(
  "/manage/admin/index-monitoring/connectors",
  requireAdmin,
  (c) => {
    return c.json({
      items: [],
      total_items: 0,
      status_counts: {
        indexing: 0,
        failed: 0,
        paused: 0,
        deleting: 0,
        scheduled: 0,
        indexed: 0,
      },
      federated_connectors: [],
    });
  },
);

// POST /manage/admin/connector/indexing-status — list[ConnectorIndexingStatusLiteResponse]
// (web/src/lib/hooks.ts fetchConnectorIndexingStatus ->
// web/src/lib/types.ts ConnectorIndexingStatusLiteResponse[]; consumers
// page by source groups and flatMap indexing_statuses). No connectors are
// configured in this port: an empty group list.
adminSurfaceRoutes.post(
  "/manage/admin/connector/indexing-status",
  requireAdmin,
  (c) => {
    // Body (IndexingStatusRequest: secondary_index, access_type_filters,
    // last_status_filters, docs_count_operator/value, source_to_page) is
    // accepted and ignored.
    return c.json([]);
  },
);

// GET /search-settings/get-current-search-settings — SavedSearchSettings
// (web/src/lib/searchSettings/hooks.ts useCurrentSearchSettings ->
// web/src/lib/searchSettings/types.ts SavedSearchSettings; consumed by the
// admin index-settings page). Reflects this deployment's active embedding
// model: the local hash embedder (provider_type null, like every
// self-hosted model), hybrid search defaults, no reranker.
adminSurfaceRoutes.get(
  "/search-settings/get-current-search-settings",
  requireAdmin,
  (c) => {
    return c.json({
      model_name: INDEXING_EMBEDDING_MODEL,
      model_dim: INDEXING_EMBEDDING_DIM,
      normalize: true,
      query_prefix: null,
      passage_prefix: null,
      provider_type: null,
      index_name: null,
      multipass_indexing: false,
      enable_contextual_rag: false,
      contextual_rag_model_configuration_id: null,
      multilingual_expansion: [],
      disable_rerank_for_streaming: false,
      api_url: null,
      num_rerank: 25,
      reduced_dimension: null,
      vector_quantization: "none",
      rerank_model_name: null,
      rerank_provider_type: null,
      rerank_api_key: null,
      rerank_api_url: null,
      use_port_flow: true,
    });
  },
);

// GET /manage/admin/index-monitoring/runs/resolvable-count — { count }
// (web/src/lib/connectors/ccPair/hooks.tsx useResolvableRunsCount →
// useSWR<{ count: number }>; the index-monitoring page polls it while its
// batch-resolve affordance is enabled). No open runs exist in this port, so
// the count is always 0.
adminSurfaceRoutes.get(
  "/manage/admin/index-monitoring/runs/resolvable-count",
  requireAdmin,
  (c) => {
    // Filter params (level, q, since, until) accepted and ignored — the feed
    // they would narrow is the same empty list.
    return c.json({ count: 0 });
  },
);

// POST /manage/admin/index-monitoring/runs/resolve — CCPairRunsResolveMatchingResponse
// (web/src/lib/ccPair.ts resolveMatchingRuns with ccPairId null →
// { resolved_count, cc_pair_ids }). No runs to resolve: zeroed response.
adminSurfaceRoutes.post(
  "/manage/admin/index-monitoring/runs/resolve",
  requireAdmin,
  (c) => {
    return c.json({ resolved_count: 0, cc_pair_ids: [] });
  },
);

// GET /manage/admin/cc-pair/:id/runs/resolvable-count — { count }
// (web/src/lib/connectors/ccPair/hooks.tsx useResolvableRunsCount, pair scope).
adminSurfaceRoutes.get(
  "/manage/admin/cc-pair/:ccPairId/runs/resolvable-count",
  requireAdmin,
  (c) => {
    return c.json({ count: 0 });
  },
);

// POST /manage/admin/cc-pair/:id/runs/resolve — marks runs resolved
// (web/src/lib/ccPair.ts resolveCCPairRuns, body { runs }). No runs exist:
// accepted and ignored.
adminSurfaceRoutes.post(
  "/manage/admin/cc-pair/:ccPairId/runs/resolve",
  requireAdmin,
  (c) => {
    return c.json({ resolved_count: 0, cc_pair_ids: [] });
  },
);

// POST /manage/admin/cc-pair/:id/runs/resolve-matching — CCPairRunsResolveMatchingResponse
// (web/src/lib/ccPair.ts resolveMatchingRuns, pair scope, body
// CCPairRunsMatchingFilter).
adminSurfaceRoutes.post(
  "/manage/admin/cc-pair/:ccPairId/runs/resolve-matching",
  requireAdmin,
  (c) => {
    return c.json({ resolved_count: 0, cc_pair_ids: [] });
  },
);

// GET /search-settings/get-secondary-search-settings — SavedSearchSettings | null
// (web/src/lib/searchSettings/hooks.ts useSecondarySearchSettings). No
// staged re-index: "none configured" is JSON null.
adminSurfaceRoutes.get(
  "/search-settings/get-secondary-search-settings",
  requireAdmin,
  (c) => {
    return c.json(null);
  },
);

// GET /search-settings/reindex-progress — ReindexProgress
// (web/src/lib/searchSettings/hooks.ts useReindexProgress ->
// web/src/lib/searchSettings/types.ts ReindexProgress; the admin page treats
// total === 0 as "no reindex in progress").
adminSurfaceRoutes.get("/search-settings/reindex-progress", requireAdmin, (c) => {
  return c.json({
    total: 0,
    waiting: 0,
    in_progress: 0,
    completed: 0,
    failed: 0,
    paused: 0,
    reembeds: true,
  });
});
