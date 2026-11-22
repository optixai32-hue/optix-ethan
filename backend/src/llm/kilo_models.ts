/**
 * Kilo Gateway model catalog — the models exposed by the Kilo AI
 * OpenAI-compatible HTTP gateway (https://api.kilo.ai/api/gateway).
 *
 * This is an added provider (not part of upstream backend/onyx/llm/
 * constants.py WELL_KNOWN_PROVIDER_NAMES): the gateway speaks the OpenAI
 * chat-completions wire format, so it is served by llm/providers/kilo.ts
 * (a thin subclass of OpenaiCompatProvider) and seeded into llm_provider /
 * model_configuration at boot by llm/setup.ts ensureKiloProvider().
 *
 * The first entry is the explicitly requested default model (Kilo gateway
 * free tier) and is used as the provider's default_model_name everywhere
 * (DB seed, factory listing, recommended-models surface).
 */

export const KILO_PROVIDER_ID = "kilo";

export interface KiloModel {
  name: string;
  displayName: string;
  supportsImageInput?: boolean;
  supportsReasoning?: boolean;
}

export const KILO_MODELS: readonly KiloModel[] = [
  // User-requested addition (Kilo gateway free tier)
  { name: "nvidia/nemotron-3-ultra-550b-a55b:free", displayName: "Nemotron 3 Ultra 550B", supportsReasoning: true },
  { name: "z-ai/glm-4.6", displayName: "GLM 4.6", supportsImageInput: false, supportsReasoning: true },
  { name: "deepseek/deepseek-chat-v4", displayName: "DeepSeek Chat v4", supportsReasoning: true },
  { name: "openai/gpt-5-mini", displayName: "GPT-5 Mini", supportsImageInput: true, supportsReasoning: true },
  { name: "anthropic/claude-haiku-4.5", displayName: "Claude Haiku 4.5", supportsImageInput: true, supportsReasoning: true },
];

/** Default Kilo model — the first catalog entry (single source of truth). */
export const KILO_DEFAULT_MODEL_NAME: string = KILO_MODELS[0].name;
