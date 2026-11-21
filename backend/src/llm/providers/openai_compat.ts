/**
 * OpenAI-compatible LLM provider — HTTP/fetch surface.
 * Port of backend/onyx/llm/api_surfaces.py (invoke + stream over an OpenAI
 * wire format) and the litellm-based pass-through of backend/onyx/llm/factory.py
 * for custom providers.
 *
 * Configuration (env-driven; provider is registered but INACTIVE by default —
 * it only activates when selected explicitly via getLLMProvider('openai-compatible')):
 *   - ONYX_OPENAI_API_BASE   e.g. https://api.openai.com/v1  (required)
 *   - ONYX_OPENAI_API_KEY    bearer token                    (optional)
 *   - ONYX_OPENAI_MODEL      fallback model name             (optional)
 *
 * Streaming is real SSE parsing over fetch; tools use the OpenAI wire format.
 */

import type {
  LLMMessage,
  LLMProvider,
  LLMRequestOpts,
  LLMStreamEvent,
  LLMToolCall,
} from "../types";
import { LLMGenerationError } from "../../utils/errors";
import { getLogger } from "../../utils/logger";
import { OPENAI_API_BASE, OPENAI_API_KEY, OPENAI_MODEL } from "../../configs/constants";

const logger = getLogger("llm.openai_compat");

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

interface OpenAiResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: unknown;
    };
    finish_reason?: string | null;
  }>;
}

interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number | null;
        id?: string | null;
        function?: { name?: string | null; arguments?: string | null };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

function parseToolCalls(raw: unknown): LLMToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: LLMToolCall[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const fn = (obj.function ?? null) as Record<string, unknown> | null;
    const name = typeof fn?.name === "string" ? fn.name : "";
    if (!name) continue;
    calls.push({
      id: typeof obj.id === "string" ? obj.id : "",
      name,
      arguments:
        typeof fn?.arguments === "string" ? fn.arguments : JSON.stringify(fn?.arguments ?? {}),
    });
  }
  return calls;
}

function contentOf(message: { content?: unknown } | undefined): string {
  if (!message || typeof message.content !== "string") return "";
  return message.content;
}

export class OpenaiCompatProvider implements LLMProvider {
  readonly providerId = "openai-compatible";
  readonly modelName: string;
  private readonly apiBase: string;
  private readonly apiKey: string | null;

  constructor(modelName?: string) {
    // Resolved config (ONYX_OPENAI_* with KILO gateway fallbacks for the
    // single-deployment Vercel build) comes from configs/constants.ts.
    this.apiBase = OPENAI_API_BASE.replace(/\/+$/, "");
    this.apiKey = OPENAI_API_KEY;
    this.modelName = modelName ?? OPENAI_MODEL;
    if (!this.apiBase) {
      // Constructed lazily; only fatal when actually invoked.
      logger.warning(
        "openai-compatible provider has no API base (ONYX_OPENAI_API_BASE/KILO_GATEWAY_BASE_URL unset) — will fail at call time",
      );
    }
  }

  private toWireMessages(messages: LLMMessage[]): OpenAiMessage[] {
    return messages.map((m) => {
      const wire: OpenAiMessage = { role: m.role, content: m.content };
      if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
        wire.tool_calls = m.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        }));
        wire.content = m.content || null;
      }
      if (m.role === "tool") {
        wire.tool_call_id = m.tool_call_id;
        wire.name = m.name;
      }
      return wire;
    });
  }

  private buildBody(messages: LLMMessage[], opts?: LLMRequestOpts, stream = false) {
    return {
      model: this.modelName,
      messages: this.toWireMessages(messages),
      stream,
      ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts?.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(opts?.tools && opts.tools.length > 0
        ? {
            tools: opts.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
    };
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  async complete(messages: LLMMessage[], opts?: LLMRequestOpts): Promise<LLMMessage> {
    if (!this.apiBase) {
      throw new LLMGenerationError("openai-compatible provider is not configured", "ONYX_OPENAI_API_BASE missing");
    }
    let response: Response;
    try {
      response = await fetch(`${this.apiBase}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.buildBody(messages, opts, false)),
        signal: opts?.signal,
      });
    } catch (err) {
      throw new LLMGenerationError("openai-compatible request failed", String(err));
    }
    if (!response.ok) {
      const detail = await response.text();
      throw new LLMGenerationError(
        `openai-compatible returned ${response.status}`,
        detail.slice(0, 500),
      );
    }
    const parsed = (await response.json()) as OpenAiResponse;
    const choice = parsed.choices?.[0];
    const toolCalls = parseToolCalls(choice?.message?.tool_calls);
    return {
      role: "assistant",
      content: contentOf(choice?.message),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  }

  async *stream(
    messages: LLMMessage[],
    opts?: LLMRequestOpts,
  ): AsyncGenerator<LLMStreamEvent, void, unknown> {
    if (!this.apiBase) {
      throw new LLMGenerationError("openai-compatible provider is not configured", "ONYX_OPENAI_API_BASE missing");
    }
    let response: Response;
    try {
      response = await fetch(`${this.apiBase}/chat/completions`, {
        method: "POST",
        headers: { ...this.headers(), Accept: "text/event-stream" },
        body: JSON.stringify(this.buildBody(messages, opts, true)),
        signal: opts?.signal,
      });
    } catch (err) {
      throw new LLMGenerationError("openai-compatible stream request failed", String(err));
    }
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new LLMGenerationError(
        `openai-compatible stream returned ${response.status}`,
        detail.slice(0, 500),
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";
    try {
      while (true) {
        if (opts?.signal?.aborted) {
          await reader.cancel();
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        let newlineIdx = sseBuffer.indexOf("\n");
        while (newlineIdx !== -1) {
          const line = sseBuffer.slice(0, newlineIdx);
          sseBuffer = sseBuffer.slice(newlineIdx + 1);
          newlineIdx = sseBuffer.indexOf("\n");
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") {
            yield { delta: "", finish_reason: "stop", done: true };
            return;
          }
          let chunk: OpenAiStreamChunk;
          try {
            chunk = JSON.parse(payload) as OpenAiStreamChunk;
          } catch {
            continue;
          }
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          const text = contentOf(delta);
          if (text) yield { delta: text };
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              yield {
                tool_calls: [
                  {
                    id: tc.id ?? "",
                    name: tc.function?.name ?? "",
                    arguments: tc.function?.arguments ?? "",
                  },
                ],
              };
            }
          }
          if (choice?.finish_reason) {
            yield { delta: "", finish_reason: choice.finish_reason };
          }
        }
      }
    } catch (err) {
      if (opts?.signal?.aborted) return;
      throw new LLMGenerationError("openai-compatible stream failed mid-flight", String(err));
    } finally {
      reader.releaseLock();
    }
    yield { delta: "", finish_reason: "stop", done: true };
  }
}
