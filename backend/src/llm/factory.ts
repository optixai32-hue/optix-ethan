/**
 * LLM provider factory — TypeScript port of backend/onyx/llm/factory.py
 * (provider routing) and backend/onyx/llm/constants.py (model registry).
 *
 * Routing rules (mirroring factory.py's `get_llm_for_persona` fallback):
 *   - providerId undefined / 'zai'      → the shared z.ai provider singleton
 *     (DEFAULT_LLM_PROVIDER in configs/constants.py).
 *   - providerId 'openai-compatible'    → a fresh OpenaiCompatProvider
 *     (env-configured; inactive unless selected).
 *   - unknown ids fall back to the default provider with a warning, mirroring
 *     factory.py's behavior of never leaving a chat without an LLM.
 *
 * The exported signatures are the STABLE contract from the original stub
 * (synchronous getLLMProvider) and must not change. The z.ai client resolves
 * lazily at call time, so construction never blocks.
 */

import type { LLMProvider } from "./types.js";
import { DEFAULT_FAST_MODEL, DEFAULT_LLM_PROVIDER, OPENAI_MODEL } from "../configs/constants.js";
import { getLogger } from "../utils/logger.js";
import { ZaiProvider } from "./providers/zai.js";
import { OpenaiCompatProvider } from "./providers/openai_compat.js";

const logger = getLogger("llm.factory");

let zaiSingleton: ZaiProvider | null = null;

/** Return the memoized default z.ai provider (constructed synchronously). */
function getZaiSingleton(modelName: string): ZaiProvider {
  if (!zaiSingleton) {
    zaiSingleton = new ZaiProvider(modelName);
  }
  return zaiSingleton;
}

/**
 * Resolve an LLMProvider. Exact stub signature preserved:
 * getLLMProvider(providerId?: string, modelName?: string): LLMProvider.
 */
export function getLLMProvider(providerId?: string, modelName?: string): LLMProvider {
  const model = modelName ?? DEFAULT_FAST_MODEL;
  if (providerId === "openai-compatible") {
    return new OpenaiCompatProvider(model);
  }
  if (providerId === undefined || providerId === "") {
    // Unset provider id: follow DEFAULT_LLM_PROVIDER (env ONYX_LLM_PROVIDER).
    // On serverless deployments (Vercel) this routes to the OpenAI-compatible
    // surface configured via ONYX_OPENAI_API_BASE/KEY; the sandbox keeps "zai".
    if (DEFAULT_LLM_PROVIDER === "openai-compatible") {
      return new OpenaiCompatProvider(model);
    }
    return getZaiSingleton(model);
  }
  if (providerId === "zai") {
    return getZaiSingleton(model);
  }
  logger.warning("unknown provider id; falling back to default", { providerId });
  return getZaiSingleton(model);
}

/**
 * List configured providers — port of the model registry surface
 * (backend/onyx/llm/constants.py MODEL_REGISTRY, trimmed to the two ported
 * providers). `openai-compatible` is registered but inactive by default; it
 * only functions when ONYX_OPENAI_API_BASE is set.
 */
export function listLLMProviders(): { id: string; model: string; isDefault: boolean }[] {
  return [
    { id: "zai", model: DEFAULT_FAST_MODEL, isDefault: DEFAULT_LLM_PROVIDER === "zai" },
    {
      id: "openai-compatible",
      model: OPENAI_MODEL,
      isDefault: DEFAULT_LLM_PROVIDER === "openai-compatible",
    },
  ];
}

/** Test hook: clear memoized providers. */
export function resetLLMProviderCache(): void {
  zaiSingleton = null;
}
