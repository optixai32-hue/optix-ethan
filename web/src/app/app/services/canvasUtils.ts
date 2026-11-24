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
 * Two UI surfaces read the same packets:
 *  - the canvas step card in the message timeline (CanvasRenderer)
 *  - the Deep Search canvas side panel (ChatCanvasPanel)
 */

/** Backend marker: research_agent_start.research_task prefix identifying the Deep Search canvas group. */
export const CANVAS_TASK_PREFIX = "Canvas : ";

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

/** True when the canvas group on this turn has been closed (section_end). */
function canvasTurnClosed(packets: Packet[], turn: number): boolean {
  return packets.some(
    (p) =>
      p.placement.turn_index === turn && p.obj.type === PacketType.SECTION_END,
  );
}

/**
 * Extract the Deep Search canvas from an assistant message's packets
 * (scans the whole message). Returns null when the message has no canvas.
 *
 * `isGenerating` comes from the caller (message.is_generating for multi-model,
 * the session's chatState for single-model streams) — the packet data alone
 * cannot tell whether the stream is still running.
 */
export function extractCanvasFromMessage(
  message: Message,
  isGenerating: boolean,
): CanvasData | null {
  const startPacket = message.packets.find(
    (p) =>
      p.obj.type === PacketType.RESEARCH_AGENT_START &&
      isCanvasTask((p.obj as ResearchAgentStart).research_task),
  );
  if (!startPacket) return null;

  const task = (startPacket.obj as ResearchAgentStart).research_task;
  const title = task.slice(CANVAS_TASK_PREFIX.length).trim();
  const turn = startPacket.placement.turn_index;
  const content = message.packets
    .filter(
      (p) =>
        p.placement.turn_index === turn &&
        (p.placement.sub_turn_index === undefined ||
          p.placement.sub_turn_index === null) &&
        p.obj.type === PacketType.INTERMEDIATE_REPORT_DELTA,
    )
    .map((p) => (p.obj as IntermediateReportDelta).content)
    .join("");
  const isStreaming = isGenerating && !canvasTurnClosed(message.packets, turn);

  return { nodeId: message.nodeId, title, content, isStreaming };
}
