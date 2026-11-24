import React, { useEffect, useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import { SvgDownload, SvgEdit } from "@opal/icons";
import { Button, CopyButton } from "@opal/components";

import MinimalMarkdown from "@/components/chat/MinimalMarkdown";
import {
  PacketType,
  ResearchAgentPacket,
  ResearchAgentStart,
} from "@/app/app/services/streamingModels";
import {
  CANVAS_TASK_PREFIX,
  canvasContentFromPackets,
  canvasSearchCount,
  extractCanvasFromMessage,
} from "@/app/app/services/canvasUtils";
import {
  MessageRenderer,
  FullChatState,
  RenderType,
} from "@/app/app/message/messageComponents/types";
import { useCanvasStore } from "@/app/app/stores/useCanvasStore";
import { useCurrentMessageTree } from "@/app/app/stores/useChatSessionStore";
import { CanvasGlyphIcon } from "@/components/canvas/CanvasGlyphIcon";
import {
  CANVAS_DOCUMENT_COMPONENTS,
  downloadCanvasDocument,
} from "@/components/canvas/canvasDocument";
import Text from "@/refresh-components/texts/Text";

/**
 * CanvasRenderer — the Deep Search canvas step in the message timeline.
 *
 * The canvas is a REAL step in the pile (like the Searching-the-web step):
 * the reference video's document card — header (glyph, title, Modifier /
 * Copier / download actions), a live scrollable document preview body, and
 * the centered "Agrandir" (expand) action.
 *
 * "Agrandir" opens the split view: the side panel (ChatCanvasPanel) shows the
 * full document and THIS step collapses into the compact pill with the
 * orange border (glyph + title + "Texte"); clicking the pill folds the panel
 * back into the inline card.
 */
export const CanvasRenderer: MessageRenderer<
  ResearchAgentPacket,
  FullChatState
> = ({ packets, messageNodeId, stopPacketSeen, renderType, children }) => {
  const t = useTranslations("chat.messages.timeline");

  const expandedNodeId = useCanvasStore((s) => s.expandedNodeId);
  const openCanvasPanel = useCanvasStore((s) => s.open);
  const closeCanvasPanel = useCanvasStore((s) => s.close);

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

  const startPacket = packets.find(
    (p) => p.obj.type === PacketType.RESEARCH_AGENT_START,
  );
  const title = startPacket
    ? (startPacket.obj as ResearchAgentStart).research_task.slice(
        CANVAS_TASK_PREFIX.length,
      )
    : "";
  const content = useMemo(() => canvasContentFromPackets(packets), [packets]);

  const isComplete =
    packets.some((p) => p.obj.type === PacketType.SECTION_END) ||
    stopPacketSeen;

  // The full canvas from the owning message — fresher than the card's grouped
  // packets (pacing can lag the stream), so Agrandir always opens the panel
  // with everything the message has already received.
  const fullCanvas = useMemo(
    () =>
      message
        ? extractCanvasFromMessage(
            message,
            !isComplete && !stopPacketSeen,
          )
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- packets mutate in place; packetCount is the memo key (AgentMessage's memo does the same)
    [message, packets, isComplete, stopPacketSeen],
  );

  const searchCount = message ? canvasSearchCount(message) : 0;

  /** The canvas's owning message node id (the panel's expansion key). */
  const ownerNodeId = message?.nodeId ?? messageNodeId ?? null;

  const isExpanded = ownerNodeId != null && expandedNodeId === ownerNodeId;

  // Status line (the pile row): the reference video's
  // "Modifié un Canvas · Effectué N recherches".
  const statusText = isComplete
    ? searchCount > 0
      ? `${t("canvas.edited.status")} · ${t("canvas.searches.count", { count: searchCount })}`
      : t("canvas.edited.status")
    : t("canvas.creating.status");

  const handleExpand = () => {
    // Prefer the owning message's full canvas (correct nodeId + every delta
    // received so far); fall back to the card's grouped view.
    const data = fullCanvas ?? {
      nodeId: ownerNodeId ?? -1,
      title,
      content,
      isStreaming: !isComplete,
    };
    openCanvasPanel({
      nodeId: data.nodeId,
      title: title || data.title,
      content: data.content || content,
      isStreaming: data.isStreaming,
    });
  };

  const handleCollapse = () => {
    closeCanvasPanel();
  };

  const previewScrollRef = useRef<HTMLDivElement>(null);
  // Follow the live stream inside the card preview (pinned to the bottom).
  useEffect(() => {
    if (isComplete) return;
    if (previewScrollRef.current) {
      previewScrollRef.current.scrollTop =
        previewScrollRef.current.scrollHeight;
    }
  }, [isComplete, content]);

  // ---- The collapsed pill (split view open): glyph + title + "Texte" with
  // the orange border, exactly the reference video's compact state. Clicking
  // it folds the panel back into the inline card.
  const collapsedPill = (
    <div
      role="button"
      tabIndex={0}
      aria-label={t("canvas.card.foldAction")}
      onClick={handleCollapse}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleCollapse();
        }
      }}
      className="group my-1 flex w-full cursor-pointer items-center gap-3 rounded-12 border border-theme-orange-04 bg-background-tint-00 px-3 py-2.5 text-start transition-colors hover:bg-action-selection-02 focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-8 border border-border-weak bg-background-tint-01">
        <CanvasGlyphIcon className="h-4.5 w-4.5 text-text-03" />
      </div>
      <div className="min-w-0 flex-1">
        <Text as="span" text03 className="block truncate">
          {title || t("canvas.card.fallbackTitle")}
        </Text>
        <Text as="span" text04 mainUiMuted className="block truncate text-xs">
          {t("canvas.card.subtitle")}
        </Text>
      </div>
    </div>
  );

  // ---- The inline document card: header (glyph, title, actions), live
  // document preview body, centered "Agrandir".
  const documentCard = (
    <div className="my-1 flex w-full flex-col rounded-12 border border-border-weak bg-background-tint-00 text-start">
      {/* Card header — the video's icon + title + Modifier / Copier / download */}
      <div className="flex items-center gap-2.5 border-b border-border-weak px-3 py-2.5">
        <CanvasGlyphIcon className="h-5 w-5 shrink-0 text-text-02" />
        <Text as="span" text03 className="min-w-0 flex-1 truncate">
          {title || t("canvas.card.fallbackTitle")}
        </Text>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            prominence="tertiary"
            size="sm"
            icon={SvgEdit}
            tooltip={t("canvas.card.edit")}
            onClick={handleExpand}
          />
          <CopyButton
            prominence="tertiary"
            size="sm"
            getCopyText={() => content}
            tooltip={t("canvas.card.copy")}
          />
          <Button
            prominence="tertiary"
            size="sm"
            icon={SvgDownload}
            tooltip={t("canvas.card.download")}
            onClick={() => downloadCanvasDocument(title, content)}
          />
        </div>
      </div>

      {/* Card body — the live document preview */}
      <div
        ref={previewScrollRef}
        className="max-h-72 min-h-16 overflow-y-auto px-4 py-3"
      >
        {content.trim() ? (
          <MinimalMarkdown
            content={content}
            streaming={!isComplete}
            components={CANVAS_DOCUMENT_COMPONENTS}
          />
        ) : (
          <div className="flex items-center gap-2 py-6">
            <Text as="p" text04 mainUiMuted>
              {t("canvas.creating.status")}
            </Text>
          </div>
        )}
      </div>

      {/* Card footer — the centered "Agrandir" action */}
      <div className="flex justify-center border-t border-border-weak px-3 py-2">
        <Button
          prominence="secondary"
          size="sm"
          onClick={handleExpand}
          aria-label={t("canvas.card.expand")}
        >
          {t("canvas.card.expand")}
        </Button>
      </div>
    </div>
  );

  const stepContent = isExpanded ? collapsedPill : documentCard;

  if (renderType === RenderType.HIGHLIGHT) {
    return children([
      {
        icon: null,
        status: null,
        content: (
          <div className="ps-(--timeline-common-text-padding)">{stepContent}</div>
        ),
        supportsCollapsible: true,
        timelineLayout: "content",
      },
    ]);
  }

  return children([
    {
      icon: CanvasGlyphIcon,
      status: statusText,
      content: stepContent,
      noPaddingRight: true,
      supportsCollapsible: true,
      timelineLayout: "timeline",
    },
  ]);
};
