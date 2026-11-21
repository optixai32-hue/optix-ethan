/**
 * Z.ai LLM provider — the default provider of the port.
 * Port of backend/onyx/llm/factory.py (default-provider routing) +
 * backend/onyx/llm/api_surfaces.py (the invoke/stream surface) onto the
 * z-ai-web-dev-sdk chat completion API.
 *
 * SDK capabilities verified against z-ai-web-dev-sdk@0.0.18 dist/index.d.ts +
 * dist/index.js:
 *   - `ZAI.create()` builds a client from .z-ai-config (project/home//etc).
 *   - `zai.chat.completions.create(body)` POSTs {baseUrl}/chat/completions;
 *     body accepts `stream?: boolean` and `thinking?: {type: enabled|disabled}`
 *     (thinking defaults to disabled). When `stream` is set and the server
 *     answers with text/event-stream or text/plain, the SDK returns the raw
 *     ReadableStream of the response body (SSE); otherwise it returns the
 *     parsed JSON — so REAL streaming is supported and used here, with a
 *     pseudo-streaming fallback when the server ignores the flag.
 *   - No typed tool-calling support in the SDK types, but the request body has
 *     an index signature, so OpenAI-wire `tools` are passed through and any
 *     `tool_calls` in the response are parsed. If the backend never returns
 *     tool_calls, this provider simply yields content (the chat engine copes).
 *
 * ROLE MAPPING NOTE (per task contract): our LLMMessage role 'system' is
 * mapped to 'assistant' ONLY here, at the SDK boundary, because the z.ai chat
 * docs specify that the leading system-style prompt must be sent as role
 * 'assistant' (the .d.ts also declares 'system', but the documented-safe path
 * is 'assistant'). Our own contract keeps 'system' distinct.
 */

import ZAI, {
  type ChatMessage,
  type CreateChatCompletionBody,
} from "z-ai-web-dev-sdk";
import type {
  LLMMessage,
  LLMProvider,
  LLMRequestOpts,
  LLMStreamEvent,
  LLMToolCall,
  LLMToolSpec,
} from "../types";
import { getLogger } from "../../utils/logger";
import { LLMGenerationError } from "../../utils/errors";

const logger = getLogger("llm.zai");

/** Minimal shape of a z.ai chat completion response (parsed JSON). */
interface ZaiChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: unknown;
    };
  }>;
}

/** Minimal shape of an SSE chunk in streaming mode (OpenAI-compatible). */
interface ZaiChatChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string | null;
        function?: { name?: string | null; arguments?: string | null };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

/** Narrow an unknown tool_calls payload into LLMToolCall[]. */
function parseToolCalls(raw: unknown): LLMToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: LLMToolCall[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const fn = (obj.function ?? null) as Record<string, unknown> | null;
    const name = typeof fn?.name === "string" ? fn.name : "";
    const id = typeof obj.id === "string" ? obj.id : "";
    if (!name) continue;
    const args =
      typeof fn?.arguments === "string"
        ? fn.arguments
        : JSON.stringify(fn?.arguments ?? {});
    calls.push({ id, name, arguments: args });
  }
  return calls;
}

function contentOf(message: { content?: unknown } | undefined): string {
  if (!message || typeof message.content !== "string") return "";
  return message.content;
}

/** OpenAI-wire tool definition built from our LLMToolSpec. */
function toWireTool(spec: LLMToolSpec): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
    },
  };
}

/**
 * Map our LLMMessage roles to the SDK's wire roles.
 * 'system' -> 'assistant' happens ONLY here (see header note); 'tool' results
 * are folded into a user-role transcript line because the z.ai chat endpoint
 * does not declare a tool role — the tool_call_id + name prefix preserves the
 * pairing for the model.
 */
function toSdkMessages(messages: LLMMessage[]): ChatMessage[] {
  return messages.map((m): ChatMessage => {
    if (m.role === "system") {
      // Documented z.ai behavior: the system-style prompt rides as 'assistant'.
      return { role: "assistant", content: m.content };
    }
    if (m.role === "tool") {
      return {
        role: "user",
        content: `[tool result for ${m.name ?? m.tool_call_id ?? "call"}]\n${m.content}`,
      };
    }
    return { role: m.role, content: m.content };
  });
}

/** Word-level pseudo-stream over a full text (fallback path). */
async function* pseudoStream(
  text: string,
  signal?: AbortSignal,
): AsyncGenerator<LLMStreamEvent, void, unknown> {
  const words = text.match(/\S+\s*/g) ?? (text ? [text] : []);
  let chunk: string[] = [];
  for (const word of words) {
    if (signal?.aborted) return;
    chunk.push(word);
    if (chunk.length >= 4) {
      yield { delta: chunk.join("") };
      chunk = [];
    }
  }
  if (chunk.length > 0) yield { delta: chunk.join("") };
  yield { delta: "", finish_reason: "stop", done: true };
}

/** Parse a `data: ...` SSE line into a JSON payload, or null for sentinels. */
function parseSseData(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (payload === "[DONE]") return null;
  return payload;
}

export class ZaiProvider implements LLMProvider {
  readonly providerId = "zai";
  readonly modelName: string;

  /** Synchronous construction — the SDK client resolves lazily at call time. */
  constructor(modelName: string) {
    this.modelName = modelName;
  }

  private buildBody(
    messages: LLMMessage[],
    opts: LLMRequestOpts | undefined,
    stream: boolean,
  ): CreateChatCompletionBody {
    const body: CreateChatCompletionBody = {
      messages: toSdkMessages(messages),
      thinking: { type: "disabled" },
      stream,
    };
    if (this.modelName !== "default") body.model = this.modelName;
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
    if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    if (opts?.tools && opts.tools.length > 0) {
      // Passed through the index signature; OpenAI wire format.
      body.tools = opts.tools.map((t) => toWireTool(t)) as CreateChatCompletionBody["tools"];
    }
    return body;
  }

  async complete(messages: LLMMessage[], opts?: LLMRequestOpts): Promise<LLMMessage> {
    const zai = await getZaiClient();
    let response: unknown;
    try {
      response = await zai.chat.completions.create(this.buildBody(messages, opts, false));
    } catch (err) {
      throw new LLMGenerationError("z.ai completion failed", String(err));
    }
    if (response instanceof ReadableStream) {
      // The server streamed anyway — drain the SSE to a full text.
      const text = await drainSseStream(response, opts?.signal);
      return { role: "assistant", content: text };
    }
    const parsed = response as ZaiChatResponse;
    const message = parsed.choices?.[0]?.message;
    const toolCalls = parseToolCalls(message?.tool_calls);
    return {
      role: "assistant",
      content: contentOf(message),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  }

  async *stream(
    messages: LLMMessage[],
    opts?: LLMRequestOpts,
  ): AsyncGenerator<LLMStreamEvent, void, unknown> {
    const zai = await getZaiClient();
    let result: unknown;
    try {
      result = await zai.chat.completions.create(this.buildBody(messages, opts, true));
    } catch (err) {
      logger.warning("z.ai stream request failed; falling back to complete()", {
        error: String(err),
      });
      const fallback = await this.complete(messages, opts);
      yield* pseudoStream(fallback.content, opts?.signal);
      return;
    }

    if (!(result instanceof ReadableStream)) {
      // The server answered a stream request with JSON: pseudo-stream it.
      const parsed = result as ZaiChatResponse;
      const message = parsed.choices?.[0]?.message;
      const toolCalls = parseToolCalls(message?.tool_calls);
      yield* pseudoStream(contentOf(message), opts?.signal);
      if (toolCalls.length > 0) {
        yield { tool_calls: toolCalls, finish_reason: "tool_calls" };
      }
      return;
    }

    // Real SSE streaming (SDK returns the raw response body ReadableStream).
    const reader = result.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let sawAny = false;
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
          const payload = parseSseData(line);
          if (payload === null) continue;
          let chunk: ZaiChatChunk;
          try {
            chunk = JSON.parse(payload) as ZaiChatChunk;
          } catch {
            continue;
          }
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          const text = contentOf(delta);
          if (text) {
            sawAny = true;
            yield { delta: text };
          }
          if (delta?.tool_calls) {
            sawAny = true;
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
      throw new LLMGenerationError("z.ai stream failed mid-flight", String(err));
    } finally {
      reader.releaseLock();
    }

    if (!sawAny && !(opts?.signal?.aborted ?? false)) {
      // Degenerate stream (server sent nothing usable): pseudo-stream fallback.
      logger.warning("z.ai stream produced no deltas; falling back to complete()");
      const fallback = await this.complete(messages, opts);
      yield* pseudoStream(fallback.content, opts?.signal);
      return;
    }
    yield { delta: "", finish_reason: "stop", done: true };
  }
}

/** Read a streamed SSE body to completion, returning concatenated content. */
async function drainSseStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  let text = "";
  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel();
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      let newlineIdx = sseBuffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = sseBuffer.slice(0, newlineIdx);
        sseBuffer = sseBuffer.slice(newlineIdx + 1);
        newlineIdx = sseBuffer.indexOf("\n");
        const payload = parseSseData(line);
        if (payload === null) continue;
        try {
          const chunk = JSON.parse(payload) as ZaiChatChunk;
          text += contentOf(chunk.choices?.[0]?.delta);
        } catch {
          continue;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return text;
}

// ---------------------------------------------------------------------------
// Client singleton
// ---------------------------------------------------------------------------

type ZaiClient = Awaited<ReturnType<typeof ZAI.create>>;

let zaiClientPromise: Promise<ZaiClient> | null = null;

/** Lazily build the shared ZAI client (config load happens once). */
export async function getZaiClient(): Promise<ZaiClient> {
  if (!zaiClientPromise) {
    zaiClientPromise = ZAI.create().catch((err) => {
      zaiClientPromise = null;
      throw err;
    });
  }
  return zaiClientPromise;
}

/** Reset the memoized client (used by tests / config reload). */
export function resetZaiClient(): void {
  zaiClientPromise = null;
}
