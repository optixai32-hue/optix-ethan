import type { Message } from "../interfaces";
import {
  IntermediateReportDelta,
  Packet,
  PacketType,
  ResearchAgentStart,
} from "./streamingModels";

/**
 * Deep Search canvas helpers.
 *
 * The Deep Search canvas is emitted by the backend as a research-agent-style
 * timeline group whose first packet is a `research_agent_start` whose
 * `research_task` is prefixed with `CANVAS_TASK_PREFIX` ("Canvas : {title}").
 * The document itself streams through the group's parent
 * `intermediate_report_delta` packets.
 *
 * Three UI surfaces read the same packets:
 *  - the canvas step card in the message timeline (CanvasRenderer)
 *  - the Deep Search canvas side panel (ChatCanvasPanel)
 *  - the canvas action pill (CanvasActionPill — the panel toolbar actions
 *    submitted as chat messages)
 */

/** Backend marker: research_agent_start.research_task prefix identifying the Deep Search canvas group. */
export const CANVAS_TASK_PREFIX = "Canvas : ";

/**
 * Frontend marker: user messages submitted by the canvas panel's toolbar
 * (Traduire, Ajouter la touche finale, Format, …) carry this prefix. The
 * backend strips it and routes the message to the canvas-action flow; the
 * frontend renders the message as the compact canvas action pill.
 */
export const CANVAS_ACTION_PREFIX = "[canvas] ";

/** True when a research_task string marks the Deep Search canvas step. */
export function isCanvasTask(
  task: string | undefined | null,
): task is string {
  return typeof task === "string" && task.startsWith(CANVAS_TASK_PREFIX);
}

/** True when a packet group is the Deep Search canvas step. */
export function isCanvasPackets(packets: Packet[]): boolean {
  return packets.some(
    (p) =>
      p.obj.type === PacketType.RESEARCH_AGENT_START &&
      isCanvasTask((p.obj as ResearchAgentStart).research_task),
  );
}

/** True when a user message text is a canvas panel toolbar action (pill). */
export function isCanvasActionMessage(message: string | null | undefined) {
  return typeof message === "string" && message.startsWith(CANVAS_ACTION_PREFIX);
}

/** The display text of a canvas action message (marker stripped). */
export function canvasActionText(message: string): string {
  return message.slice(CANVAS_ACTION_PREFIX.length).trim();
}

export interface CanvasData {
  /** The assistant message (tree node id) the canvas belongs to. */
  nodeId: number;
  /** Canvas document title (research_task minus the marker prefix). */
  title: string;
  /** Canvas markdown content (accumulated parent report deltas). */
  content: string;
  /** True while the canvas document is still streaming in. */
  isStreaming: boolean;
}

/** Concatenate the canvas's parent report deltas from a canvas packet group. */
export function canvasContentFromPackets(packets: Packet[]): string {
  return packets
    .filter(
      (p) =>
        p.obj.type === PacketType.INTERMEDIATE_REPORT_DELTA &&
        (p.placement.sub_turn_index === undefined ||
          p.placement.sub_turn_index === null),
    )
    .map((p) => (p.obj as IntermediateReportDelta).content)
    .join("");
}

/** True when the canvas group on this turn has been closed (section_end).
 * History replays carry no explicit section_end packet — the frontend
 * injects one on turn transitions — so the presence of a LATER turn also
 * marks this turn closed (the answer turn always follows the canvas turn). */
function canvasTurnClosed(packets: Packet[], turn: number): boolean {
  for (const p of packets) {
    if (
      p.obj.type === PacketType.SECTION_END &&
      p.placement.turn_index === turn
    ) {
      return true;
    }
    const later = p.placement.turn_index;
    if (later !== undefined && later !== null && later > turn) {
      return true;
    }
  }
  return false;
}

/**
 * Count the search steps the message actually ran — the "Effectué N
 * recherches" (performed N searches) line above the canvas card in the
 * reference video. Each SEARCH_TOOL_START packet is one search row in the
 * timeline (the deep research agents nest internal + web searches).
 */
export function canvasSearchCount(message: Message): number {
  return message.packets.filter(
    (p) => p.obj.type === PacketType.SEARCH_TOOL_START,
  ).length;
}

/**
 * Extract the Deep Search canvas from an assistant message's packets
 * (scans the whole message). Returns null when the message has no canvas.
 *
 * When several canvas groups live in one message (the original canvas and a
 * later action-updated one, e.g. a translation), the LATEST canvas is the
 * message's current document.
 *
 * `isGenerating` comes from the caller (message.is_generating for multi-model,
 * the session's chatState for single-model streams) — the packet data alone
 * cannot tell whether the stream is still running.
 */
export function extractCanvasFromPackets(
  packets: Packet[],
  nodeId: number,
  isGenerating: boolean,
): CanvasData | null {
  // The CURRENT canvas = the last canvas start packet.
  let startPacket: Packet | undefined;
  for (const p of packets) {
    if (
      p.obj.type === PacketType.RESEARCH_AGENT_START &&
      isCanvasTask((p.obj as ResearchAgentStart).research_task)
    ) {
      startPacket = p;
    }
  }
  if (!startPacket) return null;

  const task = (startPacket.obj as ResearchAgentStart).research_task;
  const title = task.slice(CANVAS_TASK_PREFIX.length).trim();
  const turn = startPacket.placement.turn_index;
  const content = packets
    .filter(
      (p) =>
        p.placement.turn_index === turn &&
        (p.placement.sub_turn_index === undefined ||
          p.placement.sub_turn_index === null) &&
        p.obj.type === PacketType.INTERMEDIATE_REPORT_DELTA,
    )
    .map((p) => (p.obj as IntermediateReportDelta).content)
    .join("");
  const isStreaming = isGenerating && !canvasTurnClosed(packets, turn);

  return { nodeId, title, content, isStreaming };
}

/**
 * Message-level wrapper around `extractCanvasFromPackets`.
 */
export function extractCanvasFromMessage(
  message: Message,
  isGenerating: boolean,
): CanvasData | null {
  return extractCanvasFromPackets(
    message.packets,
    message.nodeId,
    isGenerating,
  );
}
