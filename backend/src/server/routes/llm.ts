/**
 * LLM provider surface — TypeScript port of
 * backend/onyx/server/manage/llm/api.py (both the user-facing router and the
 * admin router) and server/manage/llm/models.py schemas:
 *   - GET  /llm/provider                -> LLMProviderResponse[LLMProviderDescriptor]
 *   - GET  /admin/llm/provider          -> LLMProviderResponse[LLMProviderView]
 *                                         (page_models=true; api_key masked)
 *   - GET  /admin/llm/provider/{id}     -> LLMProviderView
 *   - PUT  /admin/llm/provider          -> upsert (creation via ?is_creation=true)
 *   - DELETE /admin/llm/provider/{id}
 *   - GET  /admin/llm/custom-provider-names -> list[CustomProviderOption]
 *   - GET  /admin/llm/built-in/options[/{provider}] -> WellKnownLLMProviderDescriptor
 *   - GET  /admin/llm/decision-model    -> DecisionModelResponse
 *
 * Well-known provider metadata is DATA ported from
 * backend/onyx/llm/constants.py (WELL_KNOWN_PROVIDER_NAMES /
 * PROVIDER_DISPLAY_NAMES) and llm/well_known_providers/recommended-models.json.
 * LiteLLM's provider registry is not portable; the custom-provider list is the
 * litellm call-path registry minus well-known names (documented deviation).
 */
import { Hono } from "hono";
import { z } from "zod";
import { query, queryOne } from "../../db/client";
import { getAuth, requireAuth, requireAdmin } from "../../auth/middleware";
import { InvalidRequestError, NotFoundError } from "../../utils/errors";
import { getLogger } from "../../utils/logger";
import { OPENAI_API_BASE, OPENAI_API_KEY, OPENAI_MODEL } from "../../configs/constants";

const logger = getLogger("routes.llm");

export const llmRoutes = new Hono();

// ---------------------------------------------------------------------------
// Data ports (backend/onyx/llm/constants.py)
// ---------------------------------------------------------------------------

const WELL_KNOWN_PROVIDER_NAMES = [
  "typesafe",
  "zoom_ai",
  "openai",
  "anthropic",
  "vertex_ai",
  "bedrock",
  "openrouter",
  "azure",
  "ollama_chat",
  "lm_studio",
  "litellm_proxy",
  "bifrost",
  "openai_compatible",
  "nebius_tokenfactory",
  "portkey",
  "vercel_ai_gateway",
] as const;

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  typesafe: "TypeSafe AI",
  zoom_ai: "Zoom AI Services",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  bedrock: "Bedrock",
  bedrock_converse: "Bedrock",
  vertex_ai: "Vertex AI",
  openrouter: "OpenRouter",
  azure: "Azure",
  ollama: "Ollama",
  ollama_chat: "Ollama",
  lm_studio: "LM Studio",
  mistral: "Mistral",
  litellm_proxy: "LiteLLM Proxy",
  bifrost: "Bifrost",
  openai_compatible: "OpenAI Compatible",
  nebius_tokenfactory: "Nebius TokenFactory",
  portkey: "Portkey",
  vercel_ai_gateway: "Vercel AI Gateway",
  openai_compatible_: "OpenAI Compatible",
};

// Port of llm/well_known_providers/recommended-models.json (v1.24) — the
// provider -> default model + additional visible models recommendations.
const RECOMMENDED_MODELS: Record<
  string,
  {
    default_model: string;
    additional_visible_models: {
      name: string;
      display_name?: string;
      supports_image_input?: boolean;
      supports_reasoning?: boolean;
      max_input_tokens?: number | null;
    }[];
  }
> = {
  openai: {
    default_model: "gpt-6.1-sol",
    additional_visible_models: [
      { name: "gpt-6.1-sol", supports_image_input: true, supports_reasoning: true },
      { name: "gpt-6.1-terra", supports_image_input: true, supports_reasoning: true },
      { name: "gpt-6-luna", supports_image_input: true, supports_reasoning: true },
      { name: "gpt-6-astra", supports_image_input: true, supports_reasoning: true },
    ],
  },
  anthropic: {
    default_model: "claude-opus-5-5",
    additional_visible_models: [
      { name: "claude-opus-5-5", display_name: "Claude Opus 5.5", supports_image_input: true, supports_reasoning: true },
      { name: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", supports_image_input: true, supports_reasoning: true },
      { name: "claude-haiku-5-5", display_name: "Claude Haiku 5.5", supports_image_input: true },
      { name: "claude-fable-5-1", display_name: "Claude Fable 5.1" },
    ],
  },
  vertex_ai: {
    default_model: "gemini-4-argon",
    additional_visible_models: [
      { name: "gemini-4-argon", display_name: "Gemini 4 Argon", supports_image_input: true, supports_reasoning: true },
      { name: "gemini-3.8-flash", display_name: "Gemini 3.8 Flash", supports_image_input: true },
      { name: "gemini-3.5-flash-lite", display_name: "Gemini 3.5 Flash-Lite" },
    ],
  },
  openrouter: {
    default_model: "openrouter/auto",
    additional_visible_models: [{ name: "openrouter/auto", display_name: "Auto Router" }],
  },
  azure: {
    default_model: "gpt-4o",
    additional_visible_models: [
      { name: "gpt-4o", supports_image_input: true },
      { name: "gpt-4o-mini", supports_image_input: true },
    ],
  },
  ollama_chat: {
    default_model: "llama3.3",
    additional_visible_models: [{ name: "llama3.3" }],
  },
  lm_studio: {
    default_model: "qwen2.5",
    additional_visible_models: [{ name: "qwen2.5" }],
  },
  litellm_proxy: {
    default_model: "gpt-4o",
    additional_visible_models: [{ name: "gpt-4o", supports_image_input: true }],
  },
  bifrost: {
    default_model: "gpt-4o",
    additional_visible_models: [{ name: "gpt-4o", supports_image_input: true }],
  },
  openai_compatible: {
    default_model: "gpt-4o",
    additional_visible_models: [{ name: "gpt-4o", supports_image_input: true }],
  },
  portkey: {
    default_model: "@nyx-v1/default",
    additional_visible_models: [{ name: "@nyx-v1/default" }],
  },
  vercel_ai_gateway: {
    default_model: "openai/gpt-4o",
    additional_visible_models: [{ name: "openai/gpt-4o", supports_image_input: true }],
  },
  nebius_tokenfactory: {
    default_model: "meta-llama/Llama-3.3-70B-Instruct",
    additional_visible_models: [{ name: "meta-llama/Llama-3.3-70B-Instruct" }],
  },
  typesafe: {
    default_model: "ts-gpt-4o",
    additional_visible_models: [{ name: "ts-gpt-4o", supports_image_input: true }],
  },
  zoom_ai: {
    default_model: "zoom-ai-default",
    additional_visible_models: [{ name: "zoom-ai-default" }],
  },
  bedrock: {
    default_model: "anthropic.claude-sonnet-4-5",
    additional_visible_models: [
      { name: "anthropic.claude-sonnet-4-5", display_name: "Claude Sonnet 4.5", supports_image_input: true },
    ],
  },
};

// Port of llm/decisions/models.py DecisionProvider (StrEnum) values.
const DECISION_PROVIDERS = [
  "typesafe",
  "zoom_ai",
  "openai",
  "openrouter",
  "vercel_ai_gateway",
];

// LiteLLM call-path provider registry minus the well-known names — port of
// fetch_custom_provider_names (litellm.models_by_provider | {"typesafe"}).
const LITELLM_EXTRA_PROVIDERS: Record<string, string> = {
  ai21: "Ai21",
  aleph_alpha: "Aleph Alpha",
  amazon_nova: "Amazon Nova",
  anthropic: "Anthropic",
  anyscale: "Anyscale",
  azure_ai: "Azure AI",
  bedrock_converse: "Bedrock Converse",
  cerebras: "Cerebras",
  claude: "Claude",
  cloudflare: "Cloudflare",
  cohere: "Cohere",
  dashscope: "Dashscope",
  deepgram: "Deepgram",
  deepseek: "Deepseek",
  ember: "Ember",
  fireworks_ai: "Fireworks AI",
  gemini: "Gemini",
  github_copilot: "GitHub Copilot",
  google: "Google",
  groq: "Groq",
  huggingface: "Huggingface",
  jina_ai: "Jina AI",
  lambda_ai: "Lambda AI",
  mistral: "Mistral",
  nvidia_nim: "Nvidia NIM",
  ollama: "Ollama",
  openai: "OpenAI",
  perplexity: "Perplexity",
  predibase: "Predibase",
  replicate: "Replicate",
  sambanova: "Sambanova",
  snowflake: "Snowflake",
  together_ai: "Together AI",
  vllm: "Vllm",
  watsonx: "Watsonx",
  xai: "Xai",
};

// ---------------------------------------------------------------------------
// Row types + shared view builders
// ---------------------------------------------------------------------------

interface LlmProviderRow {
  id: number;
  name: string | null;
  provider: string;
  api_key: string | null;
  api_base: string | null;
  api_version: string | null;
  deployment_name: string | null;
  default_model_name: string | null;
  is_default: boolean;
}

interface ModelConfigRow {
  llm_provider_id: number;
  id: number;
  name: string;
  is_visible: boolean;
  supports_chat: boolean;
  supports_image_input: boolean;
  supports_reasoning: boolean;
  max_input_tokens: number | null;
}

async function fetchProviderRows(): Promise<LlmProviderRow[]> {
  const result = await query<LlmProviderRow>(
    `SELECT id, name, provider, api_key, api_base, api_version, deployment_name, default_model_name, is_default
     FROM llm_provider ORDER BY id`,
  );
  return result.rows;
}

async function fetchModelConfigRows(): Promise<ModelConfigRow[]> {
  const result = await query<ModelConfigRow>(
    `SELECT llm_provider_id, id, name, is_visible, supports_chat,
            supports_image_input, supports_reasoning, max_input_tokens
     FROM model_configuration ORDER BY id`,
  );
  return result.rows;
}

/** Port of _mask_string (server/manage/llm/api.py:187). */
function maskString(value: string): string {
  if (value.length <= 8) return "****";
  return value.slice(0, 4) + "****" + value.slice(-4);
}

/** Port of ModelConfigurationView (server/manage/llm/models.py:387). */
function toModelConfigurationView(
  cfg: ModelConfigRow,
  provider: string,
): Record<string, unknown> {
  const recommended = RECOMMENDED_MODELS[provider];
  const known = recommended?.additional_visible_models.find((m) => m.name === cfg.name);
  return {
    id: cfg.id,
    name: cfg.name,
    is_visible: cfg.is_visible,
    supports_decisions: false,
    supports_chat: cfg.supports_chat,
    max_input_tokens: cfg.max_input_tokens,
    supports_image_input: cfg.supports_image_input,
    supports_reasoning: cfg.supports_reasoning,
    supported_reasoning_efforts: cfg.supports_reasoning ? ["low", "medium", "high"] : [],
    reasoning_effort_max: null,
    reasoning_effort_default: null,
    temperature_default: null,
    is_router: false,
    is_recommended_default: recommended?.default_model === cfg.name,
    display_name: known?.display_name ?? null,
    custom_display_name: null,
    provider_display_name: PROVIDER_DISPLAY_NAMES[provider] ?? provider,
    vendor: null,
    version: null,
  };
}

/** Port of LLMProviderView (server/manage/llm/models.py:224) + mask. */
function toProviderView(
  row: LlmProviderRow,
  configs: ModelConfigRow[],
): Record<string, unknown> {
  const own = configs.filter((cfg) => cfg.llm_provider_id === row.id);
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    api_key: row.api_key ? maskString(row.api_key) : null,
    api_base: row.api_base,
    api_version: row.api_version,
    custom_config: null,
    is_public: true,
    is_auto_mode: false,
    groups: [],
    personas: [],
    deployment_name: row.deployment_name,
    zoom_voice_provider_id: null,
    provider_display_name: PROVIDER_DISPLAY_NAMES[row.provider] ?? row.name ?? row.provider,
    model_configurations: own.map((cfg) => toModelConfigurationView(cfg, row.provider)),
    next_model_configuration_offset: null,
  };
}

/**
 * Port of LLMProviderResponse.from_models + fetch_default_model:
 * the default_* fields point at the provider marked is_default (its
 * default_model_name row when present, else its first visible model).
 */
function buildResponse(
  providers: Record<string, unknown>[],
  rows: LlmProviderRow[],
  configs: ModelConfigRow[],
): Record<string, unknown> {
  const defaultRow = rows.find((row) => row.is_default);
  let defaultText: { provider_id: number; model_name: string } | null = null;
  if (defaultRow) {
    const own = configs
      .filter((cfg) => cfg.llm_provider_id === defaultRow.id && cfg.is_visible)
      .sort((a, b) => a.id - b.id);
    const chosen =
      own.find((cfg) => cfg.name === defaultRow.default_model_name) ?? own[0];
    if (chosen) {
      defaultText = { provider_id: defaultRow.id, model_name: chosen.name };
    }
  }
  return {
    providers,
    default_text: defaultText,
    default_vision: null,
    default_chat_naming: null,
    default_search_selection: null,
    default_craft: null,
  };
}

// ---------------------------------------------------------------------------
// User-facing surface (GET /llm/provider -> LLMProviderDescriptor)
// ---------------------------------------------------------------------------

/**
 * Idempotent seed: ensure the OpenAI-compatible gateway (Kilo) exposes its
 * models as a visible provider + model_configuration rows so the chat model
 * selector lists them. Env-driven: runs on both local and serverless
 * deployments; a no-op when no gateway credentials are configured.
 * Also guarantees the default provider's own default model is a visible
 * model_configuration row (fresh deployments otherwise list nothing).
 */
const KILO_REQUESTED_MODELS = ["nvidia/nemotron-3-ultra-550b-a55b:free"];
let kiloSeedAttempted = false;
async function ensureKiloGatewayModels(): Promise<void> {
  if (kiloSeedAttempted) return;
  kiloSeedAttempted = true;
  if (!OPENAI_API_BASE || !OPENAI_API_KEY) return;
  try {
    // Provider row for the gateway (Kilo) — one per deployment.
    let providerRow = await queryOne<{ id: number }>(
      "SELECT id FROM llm_provider WHERE provider = 'openai-compatible' ORDER BY id LIMIT 1",
    );
    if (!providerRow) {
      providerRow = await queryOne<{ id: number }>(
        `INSERT INTO llm_provider
           (name, provider, api_key, api_base, default_model_name, is_default)
         VALUES ('Kilo Gateway', 'openai-compatible', $1, $2, $3, false)
         RETURNING id`,
        [OPENAI_API_KEY, OPENAI_API_BASE, OPENAI_MODEL || KILO_REQUESTED_MODELS[0]],
      );
    }
    if (!providerRow) return;

    // Visible model rows: the gateway's default model + every requested
    // model (the user-requested Kilo additions). ON CONFLICT-free: checked
    // per (provider, name) to stay idempotent.
    const modelNames = new Set<string>(KILO_REQUESTED_MODELS);
    if (OPENAI_MODEL && OPENAI_MODEL !== "default") {
      modelNames.add(OPENAI_MODEL);
    }
    for (const name of modelNames) {
      const existing = await queryOne<{ id: number }>(
        "SELECT id FROM model_configuration WHERE llm_provider_id = $1 AND name = $2",
        [providerRow.id, name],
      );
      if (existing) continue;
      await query(
        `INSERT INTO model_configuration
           (llm_provider_id, name, is_visible, supports_chat, supports_image_input,
            supports_reasoning, max_input_tokens)
         VALUES ($1, $2, true, true, true, false, null)`,
        [providerRow.id, name],
      );
    }
  } catch (err) {
    logger.warning("kilo gateway model seed failed", { error: String(err) });
  }
}

llmRoutes.get("/llm/provider", requireAuth, async (c) => {
  const auth = getAuth(c);
  if (!auth) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  await ensureKiloGatewayModels();
  const rows = await fetchProviderRows();
  const configs = await fetchModelConfigRows();
  // LLMProviderDescriptor (models.py:116) — same view minus credentials.
  const providers = rows.map((row) => ({
    id: row.id,
    name: row.name,
    provider: row.provider,
    provider_display_name: PROVIDER_DISPLAY_NAMES[row.provider] ?? row.name ?? row.provider,
    model_configurations: configs
      .filter((cfg) => cfg.llm_provider_id === row.id)
      .map((cfg) => toModelConfigurationView(cfg, row.provider)),
    next_model_configuration_offset: null,
  }));
  return c.json(buildResponse(providers, rows, configs));
});

/**
 * GET /llm/persona/{persona_id}/providers — port of
 * list_llm_providers_for_persona (server/manage/llm/api.py:1766).
 *
 * Returns providers the user can access when using this persona. In this port
 * every provider row is public (is_public=true semantics, see
 * toProviderView), so the persona-scoped listing equals the global listing
 * with the persona's default model (persona.default_model_configuration_id)
 * applied to default_text when set — mirroring the Python flow:
 *   persona_default_model → DefaultModel(provider_id, model_name) override.
 */
llmRoutes.get("/llm/persona/:personaId/providers", requireAuth, async (c) => {
  const auth = getAuth(c);
  if (!auth) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  const personaId = Number(c.req.param("personaId"));
  if (!Number.isFinite(personaId)) {
    // INVALID_INPUT semantics (OnyxError in the Python source)
    return c.json({ detail: "Invalid persona id", code: "invalid_input" }, 400);
  }
  const personaRow = await queryOne<{
    default_model_configuration_id: number | null;
  }>(
    `SELECT default_model_configuration_id FROM persona WHERE id = $1`,
    [personaId],
  );
  if (!personaRow) {
    // PERSONA_NOT_FOUND semantics
    return c.json(
      { detail: `Agent with ID ${personaId} does not exist`, code: "persona_not_found" },
      404,
    );
  }

  const rows = await fetchProviderRows();
  const configs = await fetchModelConfigRows();
  const providers = rows.map((row) => ({
    id: row.id,
    name: row.name,
    provider: row.provider,
    provider_display_name: PROVIDER_DISPLAY_NAMES[row.provider] ?? row.name ?? row.provider,
    model_configurations: configs
      .filter((cfg) => cfg.llm_provider_id === row.id)
      .map((cfg) => toModelConfigurationView(cfg, row.provider)),
    next_model_configuration_offset: null,
  }));

  const response = buildResponse(providers, rows, configs) as {
    default_text: { provider_id: number; model_name: string } | null;
    [k: string]: unknown;
  };

  // Persona default model override (api.py:1810-1826)
  if (personaRow.default_model_configuration_id !== null) {
    const cfg = configs.find(
      (m) => m.id === personaRow.default_model_configuration_id,
    );
    if (cfg) {
      response.default_text = {
        provider_id: cfg.llm_provider_id,
        model_name: cfg.name,
      };
    }
  }
  return c.json(response);
});

// ---------------------------------------------------------------------------
// Admin surface
// ---------------------------------------------------------------------------

export const adminLlmRoutes = new Hono();

adminLlmRoutes.get("/admin/llm/provider", requireAdmin, async (c) => {
  const auth = getAuth(c);
  if (!auth) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  const rows = await fetchProviderRows();
  const configs = await fetchModelConfigRows();
  const providers = rows.map((row) => toProviderView(row, configs));
  return c.json(buildResponse(providers, rows, configs));
});

adminLlmRoutes.get("/admin/llm/provider/:id", requireAdmin, async (c) => {
  const auth = getAuth(c);
  if (!auth) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  const id = Number.parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) {
    throw new InvalidRequestError("Provider id must be an integer");
  }
  const rows = await fetchProviderRows();
  const row = rows.find((r) => r.id === id);
  if (!row) {
    throw new NotFoundError("LLM provider");
  }
  const configs = await fetchModelConfigRows();
  // include_api_key=True on the single-provider edit fetch (api.py:800).
  const view = toProviderView(row, configs);
  view.api_key = row.api_key;
  return c.json(view);
});

adminLlmRoutes.get("/admin/llm/custom-provider-names", requireAdmin, (c) => {
  const auth = getAuth(c);
  if (!auth) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  const wellKnown = new Set<string>(WELL_KNOWN_PROVIDER_NAMES);
  const options = Object.entries(LITELLM_EXTRA_PROVIDERS)
    .filter(([value]) => !wellKnown.has(value))
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
  return c.json(options);
});

adminLlmRoutes.get("/admin/llm/built-in/options", requireAdmin, (c) => {
  const auth = getAuth(c);
  if (!auth) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  return c.json(WELL_KNOWN_PROVIDER_NAMES.map(knownProviderDescriptor));
});

adminLlmRoutes.get("/admin/llm/built-in/options/:provider", requireAdmin, (c) => {
  const auth = getAuth(c);
  if (!auth) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  const provider = c.req.param("provider");
  if (!WELL_KNOWN_PROVIDER_NAMES.includes(provider as never)) {
    throw new NotFoundError(`Provider ${provider}`);
  }
  return c.json(knownProviderDescriptor(provider));
});

adminLlmRoutes.get("/admin/llm/router-models", requireAdmin, async (c) => {
  const auth = getAuth(c);
  if (!auth) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  // Port of list_router_model_providers (api.py:818): every provider carrying
  // router models, never truncated. Fresh deployment: none configured -> [].
  const rows = await fetchProviderRows();
  const configs = await fetchModelConfigRows();
  const views = rows
    .filter((row) =>
      configs.some((cfg) => cfg.llm_provider_id === row.id && !cfg.is_visible),
    )
    .map((row) => toProviderView(row, configs));
  return c.json(views);
});

adminLlmRoutes.get("/admin/llm/decision-model", requireAdmin, async (c) => {
  const auth = getAuth(c);
  if (!auth) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  const rows = (await fetchProviderRows()).filter((row) =>
    DECISION_PROVIDERS.includes(row.provider),
  );
  const configs = await fetchModelConfigRows();
  const providers = rows.map((row) => toProviderView(row, configs));
  return c.json({
    model: null,
    providers,
    supported_providers: DECISION_PROVIDERS,
  });
});

/** Port of WellKnownLLMProviderDescriptor from the recommendations data. */
function knownProviderDescriptor(provider: string): Record<string, unknown> {
  const rec = RECOMMENDED_MODELS[provider];
  const knownModels = (rec?.additional_visible_models ?? []).map((model, idx) => ({
    id: -(idx + 1), // not-yet-persisted rows use a synthetic negative id
    name: model.name,
    is_visible: true,
    supports_decisions: false,
    supports_chat: true,
    max_input_tokens: model.max_input_tokens ?? null,
    supports_image_input: model.supports_image_input ?? false,
    supports_reasoning: model.supports_reasoning ?? false,
    supported_reasoning_efforts: model.supports_reasoning ? ["low", "medium", "high"] : [],
    reasoning_effort_max: null,
    reasoning_effort_default: null,
    temperature_default: null,
    is_router: false,
    is_recommended_default: rec?.default_model === model.name,
    display_name: model.display_name ?? null,
    custom_display_name: null,
    provider_display_name: PROVIDER_DISPLAY_NAMES[provider] ?? provider,
    vendor: null,
    version: null,
  }));
  return {
    name: provider,
    known_models: knownModels,
    recommended_default_model: rec?.default_model ?? null,
  };
}

const upsertSchema = z.object({
  name: z.string().nullish(),
  provider: z.string().min(1),
  api_key: z.string().nullish(),
  api_base: z.string().nullish(),
  api_version: z.string().nullish(),
  custom_config: z.record(z.string(), z.string()).nullish(),
  is_public: z.boolean().optional(),
  is_auto_mode: z.boolean().optional(),
  deployment_name: z.string().nullish(),
  default_model_name: z.string().nullish(),
  is_default: z.boolean().optional(),
  id: z.number().int().nullish(),
  api_key_changed: z.boolean().optional(),
  model_configurations: z
    .array(
      z.object({
        name: z.string().min(1),
        is_visible: z.boolean().optional(),
        supports_chat: z.boolean().optional(),
        supports_image_input: z.boolean().optional(),
        supports_reasoning: z.boolean().optional(),
        max_input_tokens: z.number().int().nullish(),
      }),
    )
    .optional(),
});

adminLlmRoutes.put("/admin/llm/provider", requireAdmin, async (c) => {
  const auth = getAuth(c);
  if (!auth) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  const isCreation = (c.req.query("is_creation") ?? "false") === "true";
  let body: z.infer<typeof upsertSchema>;
  try {
    body = upsertSchema.parse(await c.req.json());
  } catch (err) {
    throw new InvalidRequestError(
      `Invalid LLM provider upsert: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let row: LlmProviderRow | null = null;
  if (body.id) {
    const existing = await queryOne<LlmProviderRow>(
      `SELECT id, name, provider, api_key, api_base, api_version, deployment_name, default_model_name, is_default
       FROM llm_provider WHERE id = $1`,
      [body.id],
    );
    if (existing && isCreation) {
      // DUPLICATE_RESOURCE
      return c.json(
        {
          detail: `LLM Provider with name ${body.name} and id=${body.id} already exists`,
        },
        400,
      );
    }
    if (!existing && !isCreation) {
      return c.json(
        {
          detail: `LLM Provider with name ${body.name} and id=${body.id} does not exist`,
        },
        404,
      );
    }
    const updated = await queryOne<LlmProviderRow>(
      `UPDATE llm_provider SET name = $1, provider = $2,
         api_key = COALESCE($3, CASE WHEN $4 THEN NULL ELSE api_key END),
         api_base = $5, api_version = $6, deployment_name = $7, default_model_name = $8
       WHERE id = $9 RETURNING id, name, provider, api_key, api_base, api_version, deployment_name, is_default`,
      [
        body.name ?? existing?.name ?? null,
        body.provider,
        body.api_key ?? null,
        body.api_key_changed ?? false,
        body.api_base ?? existing?.api_base ?? null,
        body.api_version ?? existing?.api_version ?? null,
        body.deployment_name ?? existing?.deployment_name ?? null,
        body.default_model_name ?? existing?.default_model_name ?? null,
        body.id,
      ],
    );
    row = updated ?? null;
  } else {
    if (body.is_default) {
      await query(`UPDATE llm_provider SET is_default = false WHERE is_default`);
    }
    row =
      (await queryOne<LlmProviderRow>(
        `INSERT INTO llm_provider (name, provider, api_key, api_base, api_version, deployment_name, default_model_name, is_default)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, name, provider, api_key, api_base, api_version, deployment_name, is_default`,
        [
          body.name ?? null,
          body.provider,
          body.api_key ?? null,
          body.api_base ?? null,
          body.api_version ?? null,
          body.deployment_name ?? null,
          body.default_model_name ?? null,
          body.is_default ?? false,
        ],
      )) ?? null;
  }
  if (!row) {
    return c.json({ detail: "Failed to upsert LLM provider" }, 500);
  }

  // Replace model configurations when the request carries any (write replaces;
  // keep_existing_models not honored yet — see docs/PORT_MAP.md)
  if (body.model_configurations && body.model_configurations.length > 0) {
    await query(`DELETE FROM model_configuration WHERE llm_provider_id = $1`, [row.id]);
    for (const cfg of body.model_configurations) {
      await query(
        `INSERT INTO model_configuration
           (llm_provider_id, name, is_visible, supports_chat, supports_image_input,
            supports_reasoning, max_input_tokens)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          row.id,
          cfg.name,
          cfg.is_visible ?? true,
          cfg.supports_chat ?? true,
          cfg.supports_image_input ?? false,
          cfg.supports_reasoning ?? false,
          cfg.max_input_tokens ?? null,
        ],
      );
    }
  }

  logger.info("llm provider upserted", { id: row.id, provider: row.provider });
  // LLMProviderView response (admin listing shape)
  const configs = await fetchModelConfigRows();
  return c.json(toProviderView(row, configs));
});

adminLlmRoutes.delete("/admin/llm/provider/:id", requireAdmin, async (c) => {
  const auth = getAuth(c);
  if (!auth) {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  const id = Number.parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) {
    throw new InvalidRequestError("Provider id must be an integer");
  }
  await query(`DELETE FROM model_configuration WHERE llm_provider_id = $1`, [id]);
  await query(`DELETE FROM llm_provider WHERE id = $1`, [id]);
  logger.info("llm provider deleted", { id });
  return c.json(null);
});
