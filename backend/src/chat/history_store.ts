/**
 * History store — TypeScript port of backend/onyx/chat/history_store.py (the
 * conversation-storage boundary) combined with
 * backend/onyx/chat/chat_utils.py :: convert_chat_history_basic (lines 148-200)
 * — the read path that converts persisted chat_message rows into model input.
 *
 * Behavior mirrored from convert_chat_history_basic:
 *   - only USER and ASSISTANT rows convert; everything else (files, tool
 *     responses) is omitted from the simple history,
 *   - the returned list is conversation-ordered, newest last,
 *   - the system prompt rides first (in the Python flow it is assembled by
 *     build_chat_prompt/prepare_prompt; here the caller passes it in),
 *   - a non-positive total token budget yields an empty history (defensive
 *     branch, chat_utils.py line 156).
 */

import type { ChatMessage } from "../types/domain.js";
import type { LLMMessage } from "../llm/types.js";

export interface BuildHistoryOptions {
  /** Optional per-message token cap (max_individual_message_tokens). */
  maxIndividualMessageTokens?: number;
  /** Optional total token cap; a contiguous suffix of the history is kept. */
  maxTotalTokens?: number;
}

/** Approximate token count (chars/4); exact tokenizer budgeting is out of scope. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Build LLMMessage[] history from chat_message rows, system prompt first.
 * System prompt may be empty/omitted for naming-style flows that attach it
 * separately.
 */
export function buildHistory(
  rows: ChatMessage[],
  systemPrompt?: string,
  opts: BuildHistoryOptions = {},
): LLMMessage[] {
  if (opts.maxTotalTokens !== undefined && opts.maxTotalTokens <= 0) {
    return [];
  }

  const converted: LLMMessage[] = [];
  for (const row of rows) {
    if (row.role !== "user" && row.role !== "assistant") continue;
    const tokenCount = estimateTokens(row.message);
    if (
      opts.maxIndividualMessageTokens !== undefined &&
      tokenCount > opts.maxIndividualMessageTokens
    ) {
      // Drop any single message that would dominate the context window.
      continue;
    }
    converted.push({ role: row.role, content: row.message });
  }

  let trimmed = converted;
  if (opts.maxTotalTokens !== undefined) {
    // Keep a contiguous suffix of the conversation within the total budget.
    const suffix: LLMMessage[] = [];
    let totalTokens = 0;
    for (let i = converted.length - 1; i >= 0; i -= 1) {
      const msg = converted[i];
      const cost = estimateTokens(msg.content);
      if (totalTokens + cost > opts.maxTotalTokens) break;
      suffix.unshift(msg);
      totalTokens += cost;
    }
    trimmed = suffix;
  }

  const history: LLMMessage[] = [];
  if (systemPrompt) {
    history.push({ role: "system", content: systemPrompt });
  }
  history.push(...trimmed);
  return history;
}
