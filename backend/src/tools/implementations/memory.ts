/**
 * Memory tool — TypeScript port of
 * backend/onyx/tools/tool_implementations/memory.py (MemoryTool:
 * MEMORY_TOOL_ID, NAME="memory": persist and recall durable user facts).
 *
 * Backed by the `memory` table (migration 0005) — the same store the /me
 * personalization surface reads. Write mode saves a fact; view mode lists the
 * user's stored facts. Emits memory_tool_start / memory_tool_delta packets so
 * the frontend renders the memory timeline card.
 */

import type { Tool, ToolContext, ToolResponse } from "../interface";
import { query, queryOne } from "../../db/client";
import { getLogger } from "../../utils/logger";

const logger = getLogger("tools.memory");

export const MEMORY_TOOL_ID = "memory";

const MAX_MEMORIES = 200;
const MAX_MEMORY_CHARS = 400;

interface MemoryRow {
  id: number;
  memory_text: string;
  created_at: string;
}

export const memoryTool: Tool = {
  id: MEMORY_TOOL_ID,
  name: MEMORY_TOOL_ID,
  displayName: "Memory",
  inCodeToolId: "MemoryTool",
  description:
    "Save durable facts about the user (preferences, projects, context) so future conversations remember them. View stored memories with mode='view'. Only save meaningful, reusable facts.",
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["write", "view"],
        description: "'write' to save a fact, 'view' to list stored memories.",
      },
      content: {
        type: "string",
        description: "The fact to remember (required for mode='write'). One concise fact.",
      },
    },
    required: ["mode"],
  },

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResponse> {
    const mode = typeof input.mode === "string" ? input.mode : "";
    try {
      ctx.emit?.("memory_tool_start", JSON.stringify({}));
    } catch {
      // streaming surface unavailable
    }

    if (mode === "view") {
      const res = await query<MemoryRow>(
        "SELECT id, memory_text, created_at FROM memory WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2",
        [ctx.userId, Math.min(MAX_MEMORIES, 50)],
      );
      try {
        ctx.emit?.(
          "memory_tool_delta",
          JSON.stringify({ memories: res.rows.map((r) => r.memory_text) }),
        );
      } catch {
        // ignore
      }
      if (res.rows.length === 0) {
        return { content: "No memories stored yet." };
      }
      return {
        content: res.rows
          .map((r, i) => `[${i + 1}] ${r.memory_text}`)
          .join("\n"),
      };
    }

    if (mode === "write") {
      const content = typeof input.content === "string" ? input.content.trim() : "";
      if (!content) {
        return { content: "Error: 'content' is required for mode='write'." };
      }
      const clipped = content.slice(0, MAX_MEMORY_CHARS);
      const row = await queryOne<{ id: number }>(
        "INSERT INTO memory (user_id, memory_text) VALUES ($1, $2) RETURNING id",
        [ctx.userId, clipped],
      );
      try {
        ctx.emit?.("memory_tool_delta", JSON.stringify({ memory: clipped }));
      } catch {
        // ignore
      }
      return { content: `Memory saved: "${clipped}"` };
    }

    return { content: "Error: 'mode' must be 'write' or 'view'." };
  },
};
