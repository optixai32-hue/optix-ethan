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
