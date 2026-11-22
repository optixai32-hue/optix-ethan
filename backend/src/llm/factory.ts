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

import type { LLMProvider } from "./types";
import {
  DEFAULT_FAST_MODEL,
  DEFAULT_LLM_PROVIDER,
  IS_SERVERLESS_SHARED_DB,
  OPENAI_MODEL,
} from "../configs/constants";
import { getLogger } from "../utils/logger";
import { ZaiProvider } from "./providers/zai";
import { OpenaiCompatProvider } from "./providers/openai_compat";
import { KiloProvider } from "./providers/kilo";
import { KILO_PROVIDER_ID, KILO_DEFAULT_MODEL_NAME } from "./kilo_models";

const logger = getLogger("llm.factory");

// Serverless runtimes (Vercel) cannot reach the z.ai SDK config surface.
const IS_SERVERLESS_RUNTIME = IS_SERVERLESS_SHARED_DB || Boolean(process.env.VERCEL_URL || process.env.VERCEL === "1");

let zaiSingleton: ZaiProvider | null = null;

/** Return the memoized default z.ai provider (constructed synchronously). */
function getZaiSingleton(modelName: string): ZaiProvider {
  if (!zaiSingleton) {
    zaiSingleton = new ZaiProvider(modelName);
  }
  return zaiSingleton;
}

/**
 * DB-backed default provider/model resolution — the llm_provider row written
 * through the admin surface is the single source of truth for the default
 * chat model (env constants like DEFAULT_MODELS go stale on managed
 * deployments, e.g. retired gateway models). Cached per process for 30s so
 * the hot chat path stays cheap; falls back to env constants when the DB is
 * unreachable or unseeded.
 */
const DEFAULT_PROVIDER_CACHE_TTL_MS = 30_000;
let defaultProviderCache:
  | { providerId: string; modelName: string; fetchedAt: number }
  | null = null;

async function resolveDefaultProvider(): Promise<{
  providerId: string;
  modelName: string;
}> {
  const now = Date.now();
  if (
    defaultProviderCache &&
    now - defaultProviderCache.fetchedAt < DEFAULT_PROVIDER_CACHE_TTL_MS
  ) {
    return {
      providerId: defaultProviderCache.providerId,
      modelName: defaultProviderCache.modelName,
    };
  }
  let resolved: { providerId: string; modelName: string };
  try {
    const { queryOne } = await import("../db/client");
    const row = await queryOne<{
      provider: string;
      default_model_name: string | null;
    }>(
      "SELECT provider, default_model_name FROM llm_provider WHERE is_default = true ORDER BY id LIMIT 1",
    );
    if (row?.provider) {
      resolved = {
        providerId: row.provider,
        modelName: row.default_model_name || DEFAULT_FAST_MODEL,
      };
    } else {
      resolved = { providerId: DEFAULT_LLM_PROVIDER, modelName: DEFAULT_FAST_MODEL };
    }
  } catch (err) {
    logger.warning("default provider DB lookup failed; using env defaults", {
      error: String(err),
    });
    resolved = { providerId: DEFAULT_LLM_PROVIDER, modelName: DEFAULT_FAST_MODEL };
  }
  // The z.ai SDK surface has no config in serverless runtimes — reroute to
  // the OpenAI-compatible gateway there.
  if (
    resolved.providerId === "zai" &&
    IS_SERVERLESS_RUNTIME
  ) {
    resolved = { providerId: "openai-compatible", modelName: resolved.modelName };
  }
  defaultProviderCache = { ...resolved, fetchedAt: now };
  return resolved;
}

/**
 * Resolve an LLMProvider (async: the default provider/model comes from the
 * DB when no explicit providerId/modelName is given).
 * getLLMProvider(providerId?: string, modelName?: string): Promise<LLMProvider>.
 */
export async function getLLMProvider(
  providerId?: string,
  modelName?: string,
): Promise<LLMProvider> {
  if (providerId === "openai-compatible") {
    return new OpenaiCompatProvider(modelName ?? OPENAI_MODEL);
  }
  if (providerId === KILO_PROVIDER_ID) {
    // The gateway's OpenAI-compatible surface is per-call stateless, so a
    // fresh provider carrying the selected model name is correct.
    return new KiloProvider(modelName ?? KILO_DEFAULT_MODEL_NAME);
  }
  if (providerId === "zai") {
    return getZaiSingleton(modelName ?? DEFAULT_FAST_MODEL);
  }
  if (providerId === undefined || providerId === "") {
    // Unset provider id: follow the DB-backed default (admin-managed),
    // falling back to env routing when the lookup yields nothing.
    const def = await resolveDefaultProvider();
    const model =
      modelName && modelName !== "default" ? modelName : def.modelName;
    if (def.providerId === "openai-compatible") {
      return new OpenaiCompatProvider(model);
    }
    return getZaiSingleton(model);
  }
  logger.warning("unknown provider id; falling back to default", { providerId });
  const def = await resolveDefaultProvider();
  const model = modelName && modelName !== "default" ? modelName : def.modelName;
  if (def.providerId === "openai-compatible") {
    return new OpenaiCompatProvider(model);
  }
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
    // The Kilo gateway always appears — DB visibility is gated by the
    // llm/setup.ts seed instead.
    { id: KILO_PROVIDER_ID, model: KILO_DEFAULT_MODEL_NAME, isDefault: DEFAULT_LLM_PROVIDER === KILO_PROVIDER_ID },
  ];
}

/** Test hook: clear memoized providers. */
export function resetLLMProviderCache(): void {
  zaiSingleton = null;
}
