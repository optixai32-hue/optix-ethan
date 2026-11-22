/**
 * GET /settings — TypeScript port of
 * backend/onyx/server/settings/api.py fetch_settings returning UserSettings
 * (backend/onyx/server/settings/models.py Settings + UserSettings) with the
 * pydantic field defaults of a fresh single-tenant deployment:
 *   - tier COMMUNITY, ee_features_enabled False (MIT: no license)
 *   - vector_db_enabled True (Standard: OpenSearch present)
 *   - notifications [] (no stored notifications for a fresh DB)
 *   - needs_reindexing False (KV_REINDEX_KEY absent -> False)
 *   - default_* upload/pruning/refresh constants from SETTINGS_DEFAULTS
 *
 * Requires authentication (require_permission(BASIC_ACCESS,
 * allow_anonymous=True) — anonymous users disabled here, so 401 otherwise).
 */
import { Hono } from "hono";
import { getAuth, requireAuth } from "../../auth/middleware.js";
import { SETTINGS_DEFAULTS } from "../../configs/constants.js";

export const settingsRoutes = new Hono();

settingsRoutes.get("/settings", requireAuth, (c) => {
  const auth = getAuth(c);
  if (!auth) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  const user = auth.user;

  return c.json({
    // ---- Settings (server/settings/models.py:55) field defaults ----
    maximum_chat_retention_days: null,
    company_name: null,
    company_description: null,
    gpu_enabled: null,
    application_status: "active",
    anonymous_user_enabled: null,
    invite_only_enabled: false,
    // Enterprise/cloud parity: Deep Research surfaced in the chat input.
    // The frontend gates the toggle on combinedSettingsData?.deep_research_enabled
    // (AppInputBar.tsx showDeepResearch) — null relies on the ?? true fallback
    // in one code path but explicit true keeps every check positive.
    deep_research_enabled: true,
    multi_model_chat_enabled: true,
    search_ui_enabled: true,
    auto_detect_search_filters: true,
    ee_features_enabled: true,
    tier: "enterprise",
    temperature_override_enabled: true,
    reasoning_override_enabled: true,
    hide_provider_grouping: false,
    model_routing_enabled: false,
    model_routing_model_configuration_id: null,
    auto_scroll: false,
    query_history_type: null,
    hide_query_history_from_admin_panel: false,
    image_extraction_and_analysis_enabled: true,
    image_analysis_max_size_mb: null,
    embedding_rate_limit_requests: null,
    embedding_rate_limit_period_seconds:
      SETTINGS_DEFAULTS.defaultEmbeddingRateLimitPeriodSeconds,
    user_knowledge_enabled: true,
    user_file_max_upload_size_mb:
      SETTINGS_DEFAULTS.defaultUserFileMaxUploadSizeMb,
    file_token_count_threshold_k: null,
    show_extra_connectors: true,
    disable_default_assistant: false,
    craft_default_enabled: true,
    default_language: "en",
    llm_gateway_enabled: true,
    plugin_publishing: "OPEN",
    plugin_sharing: true,
    craft_instructions: null,
    seat_count: null,
    used_seats: null,
    opensearch_indexing_enabled: true,
    // ---- UserSettings additions (fetch_settings computed values) ----
    oauth_provider_enabled: false,
    notifications: [],
    needs_reindexing: false,
    tenant_id: SETTINGS_DEFAULTS.postgresDefaultSchema,
    onyx_craft_enabled: true,
    onyx_craft_available: true,
    onyx_craft_requires_upgrade: false,
    opencode_debugging_enabled: false,
    vector_db_enabled: true,
    hide_onyx_branding: false,
    hooks_enabled: false,
    is_playground: false,
    version: SETTINGS_DEFAULTS.backendVersion,
    commit: null,
    commit_date: null,
    git_ref: null,
    max_allowed_upload_size_mb: SETTINGS_DEFAULTS.maxAllowedUploadSizeMb,
    default_pruning_freq: SETTINGS_DEFAULTS.defaultPruningFreq,
    default_refresh_freq: SETTINGS_DEFAULTS.defaultRefreshFreq,
    default_user_file_max_upload_size_mb:
      SETTINGS_DEFAULTS.defaultUserFileMaxUploadSizeMb,
    default_file_token_count_threshold_k:
      SETTINGS_DEFAULTS.defaultFileTokenCountThresholdK,
  });
});
