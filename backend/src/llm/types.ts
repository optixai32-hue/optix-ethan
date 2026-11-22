/**
 * LLM provider contracts — port of backend/onyx/llm (factory.py, model routing).
 * The inference_model_server HTTP boundary is preserved via these interfaces.
 */

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: string; // JSON-encoded arguments, matching OpenAI wire format
}

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: LLMToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface LLMToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema
}

export interface LLMRequestOpts {
  tools?: LLMToolSpec[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LLMStreamEvent {
  delta?: string;
  /** Reasoning/thinking tokens streamed before the answer (DeepSeek-style
   * `reasoning_content`, OpenRouter/NVIDIA-style `reasoning`). */
  reasoning?: string;
  tool_calls?: LLMToolCall[];
  finish_reason?: string | null;
  done?: boolean;
}

export interface LLMProvider {
  readonly providerId: string;
  readonly modelName: string;
  /** Full completion (non-streaming). */
  complete(messages: LLMMessage[], opts?: LLMRequestOpts): Promise<LLMMessage>;
  /** Streaming completion; emits text deltas and/or tool call events. */
  stream(messages: LLMMessage[], opts?: LLMRequestOpts): AsyncGenerator<LLMStreamEvent, void, unknown>;
}
