/**
 * Kilo Gateway LLM provider — thin subclass of OpenaiCompatProvider pointed
 * at the Kilo AI OpenAI-compatible HTTP gateway. Reuses the existing
 * invoke/SSE-stream/tool-calling surface of providers/openai_compat.ts (the
 * port of backend/onyx/llm/api_surfaces.py), only swapping provider id,
 * base URL, and credentials (equivalent of the litellm "openai_compatible"
 * pass-through in backend/onyx/llm/factory.py, targeting Kilo's gateway).
 *
 * Configuration (env-driven):
 *   - KILO_GATEWAY_BASE_URL   explicit gateway base (may already carry a
 *                             versioned or OpenAI-compatible path)
 *   - KILO_GATEWAY_API_KEY    bearer token for the gateway
 *   - ONYX_OPENAI_API_BASE /  generic OpenAI-compatible fallbacks
 *     ONYX_OPENAI_API_KEY
 *
 * Base-URL resolution (documented; verified against the live gateway):
 *   - KILO_GATEWAY_BASE_URL set: strip trailing slashes; used verbatim when it
 *     already ends in "/v1" or contains "/openai-compatible"; otherwise
 *     compose the compatible chat surface onto the bare gateway root. NOTE
 *     (deviation from the originally specified "/openai-compatible" suffix):
 *     the live gateway REJECTS /api/gateway/openai-compatible/* with
 *     `{"error":"Invalid path","message":"This endpoint only accepts the
 *     paths `/chat/completions`, `/responses` and `/messages`."}` and serves
 *     its OpenAI-compatible surface under the versioned prefix —
 *     https://api.kilo.ai/api/gateway/v1/chat/completions was verified to
 *     return HTTP 200 for nvidia/nemotron-3-ultra-550b-a55b:free — so a bare
 *     gateway root gets "/v1" appended instead.
 *   - ONYX_OPENAI_API_BASE fallback: used verbatim (that env already denotes
 *     a full OpenAI-compatible chat surface — no path is appended).
 *   - Neither set: the kilo.ai gateway's OpenAI-compatible surface verbatim:
 *     https://api.kilo.ai/api/gateway/v1
 */

import { OpenaiCompatProvider } from "./openai_compat";

const KILO_GATEWAY_DEFAULT_COMPAT_BASE = "https://api.kilo.ai/api/gateway/v1";
const KILO_GATEWAY_OPENAI_COMPAT_MARKER = "/openai-compatible";

/** Resolve the Kilo gateway chat-completions base (no trailing slash). */
export function resolveKiloGatewayBase(): string {
  const explicit = process.env.KILO_GATEWAY_BASE_URL;
  if (explicit && explicit.trim()) {
    const base = explicit.trim().replace(/\/+$/, "");
    if (base.endsWith("/v1") || base.includes(KILO_GATEWAY_OPENAI_COMPAT_MARKER)) {
      // Caller pointed at a versioned or pre-composed surface: verbatim.
      return base;
    }
    // Bare gateway root: compose the compatible chat surface (see docblock —
    // the live gateway's compatible mount is the versioned /v1 prefix).
    return `${base}/v1`;
  }
  const fallback = process.env.ONYX_OPENAI_API_BASE;
  if (fallback && fallback.trim()) {
    return fallback.trim().replace(/\/+$/, "");
  }
  return KILO_GATEWAY_DEFAULT_COMPAT_BASE;
}

/** Resolve the Kilo gateway bearer key (generic OpenAI env as fallback). */
export function resolveKiloApiKey(): string | null {
  return process.env.KILO_GATEWAY_API_KEY ?? process.env.ONYX_OPENAI_API_KEY ?? null;
}

export class KiloProvider extends OpenaiCompatProvider {
  override readonly providerId = "kilo";

  constructor(modelName?: string) {
    super(modelName, resolveKiloGatewayBase(), resolveKiloApiKey());
  }
}
