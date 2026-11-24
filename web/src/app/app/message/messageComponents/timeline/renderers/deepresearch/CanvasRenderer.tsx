import React, { useMemo } from "react";
import { useTranslations } from "next-intl";

import {
  Packet,
  PacketType,
  ResearchAgentPacket,
  ResearchAgentStart,
} from "@/app/app/services/streamingModels";
import {
  CANVAS_TASK_PREFIX,
  canvasSearchCount,
} from "@/app/app/services/canvasUtils";
import {
  MessageRenderer,
  FullChatState,
  RenderType,
} from "@/app/app/message/messageComponents/types";
import { useCurrentMessageTree } from "@/app/app/stores/useChatSessionStore";
import { CanvasGlyphIcon } from "@/components/canvas/CanvasGlyphIcon";
import Text from "@/refresh-components/texts/Text";

/**
 * CanvasRenderer — the Deep Search canvas STATUS ROW in the step pile.
 *
 * The document card itself is NOT here: the reference video's card floats
 * free in the message flow, outside the step pill — AgentMessage mounts it
 * below the pile via `CanvasInlineCard`. This renderer only contributes the
 * slim pile row ("Création du Canvas…" / "Modifié un Canvas · Effectué N
 * recherches"), exactly like a "Searched the web" row.
 *
 * A content-filter restart splits the update across several canvas turns
 * (a fresh `research_agent_start` per attempt): only the LATEST attempt is
 * the message's real canvas — every earlier attempt is superseded and
 * renders nothing (its partial text was discarded by the backend).
 */
export const CanvasRenderer: MessageRenderer<
  ResearchAgentPacket,
  FullChatState
> = ({ packets, messageNodeId, stopPacketSeen, renderType, children }) => {
  const t = useTranslations("chat.messages.timeline");

  const messageTree = useCurrentMessageTree();
  // The owning assistant message: the timeline render path does not thread
  // messageNodeId down, and the store's tree can be rebuilt with freshly
  // parsed packets (object identity is not stable across rebuilds) — so the
  // message is found by VALUE: the assistant message carrying THIS canvas's
  // start packet (same turn_index AND same research_task text). Turn index
  // alone is not enough: every deep-search message puts its canvas on the
  // same turn, so the task text is what tells one session's canvases apart
  // (the task carries the unique "Canvas : {title}"). Reverse iteration: the
  // LATEST matching message wins, so a regenerated branch owns its canvas.
  const message = useMemo(() => {
    if (!messageTree) return undefined;
    if (messageNodeId !== undefined && messageNodeId !== null) {
      const direct = messageTree.get(messageNodeId);
      if (direct) return direct;
    }
    const start = packets.find(
      (p) => p.obj.type === PacketType.RESEARCH_AGENT_START,
    );
    if (!start) return undefined;
    const canvasTurn = start.placement.turn_index;
    const canvasTask = (start.obj as ResearchAgentStart).research_task;
    if (canvasTurn === undefined || canvasTask === undefined) {
      return undefined;
    }
    for (const candidate of [...messageTree.values()].reverse()) {
      if (candidate.type !== "assistant") continue;
      const owns = candidate.packets?.some(
        (p) =>
          p.obj.type === PacketType.RESEARCH_AGENT_START &&
          (p.obj as ResearchAgentStart).research_task === canvasTask &&
          p.placement.turn_index === canvasTurn,
      );
      if (owns) return candidate;
    }
    return undefined;
  }, [messageTree, messageNodeId, packets]);

  // Superseded attempt: the message carries a LATER canvas start (a
  // content-filter restart bumped the canvas turn) — this group's partial
  // text was discarded by the backend, so it renders nothing at all.
  const superseded = useMemo(() => {
    if (!message) return false;
    const start = packets.find(
      (p) => p.obj.type === PacketType.RESEARCH_AGENT_START,
    );
    if (!start) return false;
    const thisTurn = start.placement.turn_index;
    if (thisTurn === undefined) return false;
    let laterStart: Packet | undefined;
    for (const p of message.packets) {
      if (
        p.obj.type === PacketType.RESEARCH_AGENT_START &&
        (p.obj as ResearchAgentStart).research_task ===
          (start.obj as ResearchAgentStart).research_task &&
        p.placement.turn_index !== undefined &&
        p.placement.turn_index > thisTurn
      ) {
        laterStart = p;
        break;
      }
    }
    return laterStart !== undefined;
  }, [message, packets]);

  const isComplete =
    packets.some((p) => p.obj.type === PacketType.SECTION_END) ||
    stopPacketSeen;

  // The pile row: the reference video's
  // "Modifié un Canvas · Effectué N recherches".
  const searchCount = message ? canvasSearchCount(message) : 0;
  const statusText = isComplete
    ? searchCount > 0
      ? `${t("canvas.edited.status")} · ${t("canvas.searches.count", { count: searchCount })}`
      : t("canvas.edited.status")
    : t("canvas.creating.status");

  // A superseded restart attempt renders NOTHING (its partial text was
  // discarded; the latest attempt is the message's real canvas).
  if (superseded) {
    return children([]);
  }

  if (renderType === RenderType.HIGHLIGHT) {
    // Collapsed streaming view (the pile folded while the canvas writes):
    // a single muted status line — the card streams below the pile via
    // CanvasInlineCard, never inside this pill.
    return children([
      {
        icon: null,
        status: null,
        content: (
          <div className="ps-(--timeline-common-text-padding) pb-1">
            <Text as="p" mainUiMuted text04>
              {statusText}
            </Text>
          </div>
        ),
        timelineLayout: "content",
      },
    ]);
  }

  // Expanded pile: a slim status-only row (icon + status text). content is
  // null — no body, no collapse chrome; the document card lives outside the
  // pile (CanvasInlineCard).
  return children([
    {
      icon: CanvasGlyphIcon,
      status: statusText,
      content: null,
      supportsCollapsible: false,
      timelineLayout: "timeline",
    },
  ]);
};
