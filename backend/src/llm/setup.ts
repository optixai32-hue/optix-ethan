/**
 * Dev-preset LLM provider bootstrap — TypeScript port of the GEN_AI_API_KEY
 * block in backend/onyx/setup.py setup_postgres (api.py flow):
 *
 *   if GEN_AI_API_KEY and fetch_default_model(CHAT) is None:
 *       seed "DevEnvPresetOpenAI" provider + model configs + default model
 *
 * Deviation (documented): this port's inference boundary is the z-ai backend
 * SDK rather than OpenAI, so the dev preset provider is the "zai" provider
 * served by llm/factory.ts (getLLMProvider routing). The seed is skipped
 * entirely when any provider row already exists (admin-managed state wins),
 * mirroring the fetch_default_model(...) is None guard.
 */
import { query, queryOne } from "../db/client";
import { getLogger } from "../utils/logger";
import {
  DEFAULT_LLM_PROVIDER,
  DEFAULT_STRONG_MODEL,
} from "../configs/constants";
import {
  KILO_PROVIDER_ID,
  KILO_DEFAULT_MODEL_NAME,
  KILO_MODELS,
  type KiloModel,
} from "./kilo_models";
import { resolveKiloGatewayBase } from "./providers/kilo";

const logger = getLogger("setup.llm");

interface ProviderRow {
  id: number;
}

export async function ensureDevPresetLlmProvider(): Promise<void> {
  const existing = await queryOne<ProviderRow>(
    `SELECT id FROM llm_provider ORDER BY id LIMIT 1`,
  );
  if (existing) {
    logger.debug("llm provider rows exist; skipping dev preset seed");
    return;
  }

  const providerName = "DevEnvPresetZai";
  // Model configurations for the preset: one visible chat model served by the
  // factory's zai provider. Model flow flags mirror ModelConfigurationUpsert.
  const modelName = DEFAULT_STRONG_MODEL === "default" ? "zai-default" : DEFAULT_STRONG_MODEL;

  const inserted = await queryOne<ProviderRow>(
    `INSERT INTO llm_provider (name, provider, api_key, api_base, api_version,
                               deployment_name, default_model_name, is_default)
     VALUES ($1, $2, NULL, NULL, NULL, NULL, $3, true)
     RETURNING id`,
    [providerName, DEFAULT_LLM_PROVIDER, modelName],
  );
  if (!inserted) {
    logger.warning("failed to seed dev preset llm provider");
    return;
  }

  const modelConfig = await queryOne<{ id: number }>(
    `INSERT INTO model_configuration (llm_provider_id, name, is_visible,
                                      supports_chat, supports_image_input,
                                      supports_reasoning, max_input_tokens)
     VALUES ($1, $2, true, true, false, false, NULL)
     RETURNING id`,
    [inserted.id, modelName],
  );

  // Port of update_default_model (db/llm.py:2073) as reached from the
  // GEN_AI_API_KEY block: mark the seeded model as the CHAT-flow default.
  // This port has no LLMModelFlow table; the persona linkage plays that
  // role (persona.default_model_configuration_id drives the frontend
  // model selector and get_persona model resolution).
  if (modelConfig) {
    await query(
      `UPDATE persona
         SET default_model_configuration_id = $1,
             llm_model_version_override = NULL,
             updated_at = now()
       WHERE id = 0`,
      [modelConfig.id],
    );
  }

  logger.info("seeded dev preset llm provider", {
    provider: providerName,
    model: modelName,
  });
}

// ---------------------------------------------------------------------------
// Kilo Gateway provider bootstrap (added provider — no upstream setup.py
// counterpart; follows the ensureDevPresetLlmProvider seeding pattern).
// ---------------------------------------------------------------------------

interface SeedProviderRow {
  id: number;
}

/** Insert one visible chat model_configuration row per Kilo catalog entry. */
async function insertKiloModelConfigurations(
  providerId: number,
  models: readonly KiloModel[],
): Promise<void> {
  for (const model of models) {
    await query(
      `INSERT INTO model_configuration (llm_provider_id, name, is_visible,
                                        supports_chat, supports_image_input,
                                        supports_reasoning, max_input_tokens)
       VALUES ($1, $2, true, true, $3, $4, NULL)`,
      [providerId, model.name, model.supportsImageInput ?? false, model.supportsReasoning ?? false],
    );
  }
}

/**
 * Kilo Gateway provider bootstrap (added provider — no upstream setup.py
 * counterpart; follows the ensureDevPresetLlmProvider seeding pattern).
 *
 * Idempotent: if an llm_provider row with provider = 'kilo' exists and
 * already has a model_configuration row for every KILO_MODELS entry, this is
 * a no-op. Otherwise the provider row (missing) and/or the missing
 * model_configuration rows are inserted — never duplicated, since the table
 * pair has no unique constraint on (provider / llm_provider_id, name).
 *
 * The provider row stores api_key NULL (runtime auth is resolved from
 * KILO_GATEWAY_API_KEY / ONYX_OPENAI_API_KEY env at call time by
 * llm/providers/kilo.ts) and api_base equal to the provider class's base
 * resolution. is_default stays false — the default provider row keeps the
 * default slot.
 */
export async function ensureKiloProvider(): Promise<void> {
  const existing = await queryOne<SeedProviderRow>(
    `SELECT id FROM llm_provider WHERE provider = $1 ORDER BY id LIMIT 1`,
    [KILO_PROVIDER_ID],
  );

  if (existing) {
    // Provider row exists: backfill only the missing model_configuration rows.
    const present = await query<{ name: string }>(
      `SELECT name FROM model_configuration WHERE llm_provider_id = $1`,
      [existing.id],
    );
    const presentNames = new Set(present.rows.map((row) => row.name));
    const missing = KILO_MODELS.filter((model) => !presentNames.has(model.name));
    if (missing.length === 0) {
      logger.debug("kilo gateway provider fully seeded; skipping");
      return;
    }
    await insertKiloModelConfigurations(existing.id, missing);
    logger.info("backfilled missing kilo gateway model configurations", {
      models: missing.map((model) => model.name),
    });
    return;
  }

  const inserted = await queryOne<SeedProviderRow>(
    // Column set matches this repo's llm_provider schema (no api_version /
    // deployment_name columns in the ported DDL).
    `INSERT INTO llm_provider (name, provider, api_key, api_base,
                               default_model_name, is_default)
     VALUES ($1, $2, NULL, $3, $4, false)
     RETURNING id`,
    ["Kilo Gateway", KILO_PROVIDER_ID, resolveKiloGatewayBase(), KILO_DEFAULT_MODEL_NAME],
  );
  if (!inserted) {
    logger.warning("failed to seed kilo gateway llm provider");
    return;
  }

  await insertKiloModelConfigurations(inserted.id, KILO_MODELS);
  logger.info("seeded kilo gateway llm provider", {
    provider: KILO_PROVIDER_ID,
    api_base: resolveKiloGatewayBase(),
    default_model: KILO_DEFAULT_MODEL_NAME,
    models: KILO_MODELS.length,
  });
}
