/**
 * StreamBuffer — TypeScript port of backend/onyx/chat/stream_buffer.py.
 *
 * The current Python stream_buffer.py is the resumable Redis-backed chunk
 * writer (`StreamBufferWriter`/`ChatStream`); its core contract is documented
 * in its module docstring: "Deliver live chat packets and retain resumable
 * chunks in the cache... Missing chunks require fallback to persisted
 * conversation history." This port preserves the two behaviors the chat turn
 * needs locally, mirroring the classic (pre-Redis) StreamBuffer semantics:
 *
 *   1. Delta buffering — LLM text deltas are accumulated into the full
 *      response (the replay buffer the agent emits after a step completes,
 *      bounded by a byte cap with a truncated flag, mirroring
 *      CHAT_STREAM_BUFFER_MAX_BYTES / mark_truncated).
 *   2. Tool-call accumulation — OpenAI-wire-style tool_call deltas
 *      (`{index, id?, function?: {name?, arguments?}}`) are merged by index
 *      into complete LLMToolCall entries, exactly how litellm's streamed
 *      `delta.tool_calls` fragments must be reassembled in the Onyx agent.
 *
 * Every loop feeding this buffer carries its own escape hatch (AbortSignal /
 * max iterations) upstream; the buffer additionally guards its own size.
 */

import type { LLMToolCall } from "../llm/types.js";

/** Port of CHAT_STREAM_BUFFER_MAX_BYTES (4 MiB backlog bound in stream_buffer.py). */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

interface ToolCallFragment {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

export class StreamBuffer {
  private readonly deltas: string[] = [];
  private readonly fragments = new Map<number, ToolCallFragment>();
  private totalBytes = 0;
  private readonly maxBytes: number;
  private truncated = false;
  private finished = false;

  constructor(maxBytes = DEFAULT_MAX_BYTES) {
    this.maxBytes = maxBytes;
  }

  /** Append one text delta to the buffer. */
  processToken(delta: string): void {
    if (this.truncated || this.finished) return;
    this.deltas.push(delta);
    this.totalBytes += Buffer.byteLength(delta, "utf8");
    if (this.totalBytes > this.maxBytes) {
      // mark_truncated(): stop accepting data; the persisted answer is cut.
      this.truncated = true;
    }
  }

  /** Accumulate one streamed tool_call fragment (OpenAI wire format). */
  processToolCallDelta(fragment: {
    index?: number | null;
    id?: string | null;
    name?: string | null;
    argumentsDelta?: string | null;
  }): void {
    if (this.truncated) return;
    // Two wire shapes are handled: OpenAI-style fragments carry an explicit
    // `index` and merge by it; z.ai-style fragments omit `index`, so a fresh
    // non-empty `id` starts a NEW call and other deltas append to the call
    // accumulated most recently.
    let index = fragment.index ?? null;
    if (index === null) {
      const last = [...this.fragments.values()].sort(
        (a, b) => a.index - b.index,
      ).pop();
      if (fragment.id && fragment.id !== last?.id) {
        index = last ? last.index + 1 : 0;
      } else {
        index = last ? last.index : 0;
      }
    }
    const existing = this.fragments.get(index);
    const next: ToolCallFragment = {
      index,
      id: fragment.id ?? existing?.id ?? "",
      name: fragment.name ?? existing?.name ?? "",
      arguments:
        (existing?.arguments ?? "") + (fragment.argumentsDelta ?? ""),
    };
    this.fragments.set(index, next);
  }

  /** Fully accumulated response text so far (port of the replay buffer). */
  fullResponse(): string {
    return this.deltas.join("");
  }

  /** Individual deltas in order — replayed through the citation processor. */
  getDeltas(): string[] {
    return [...this.deltas];
  }

  /** Complete, merged tool calls in fragment-index order. */
  getToolCalls(): LLMToolCall[] {
    return [...this.fragments.values()]
      .sort((a, b) => a.index - b.index)
      .map((f) => ({
        id: f.id,
        name: f.name,
        arguments: f.arguments,
      }));
  }

  isTruncated(): boolean {
    return this.truncated;
  }

  /** Seal the buffer (mark_done()); further writes are ignored. */
  finish(): void {
    this.finished = true;
  }

  isFinished(): boolean {
    return this.finished;
  }

  reset(): void {
    this.deltas.length = 0;
    this.fragments.clear();
    this.totalBytes = 0;
    this.truncated = false;
    this.finished = false;
  }
}
