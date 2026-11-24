import React, { useMemo } from "react";
import { useTranslations } from "next-intl";
import { SvgFileText, SvgMaximize2 } from "@opal/icons";
import { Button } from "@opal/components";

import {
  PacketType,
  ResearchAgentPacket,
  ResearchAgentStart,
} from "@/app/app/services/streamingModels";
import {
  CANVAS_TASK_PREFIX,
  canvasContentFromPackets,
} from "@/app/app/services/canvasUtils";
import {
  MessageRenderer,
  FullChatState,
  RenderType,
} from "@/app/app/message/messageComponents/types";
import { useCanvasStore } from "@/app/app/stores/useCanvasStore";
import Text from "@/refresh-components/texts/Text";

/**
 * CanvasRenderer — the Deep Search canvas step in the message timeline.
 *
 * The canvas is a REAL step in the pile (like the Searching-the-web step):
 * while the canvas document streams, the step shows "creating the canvas";
 * the document itself writes live into the side panel (ChatCanvasPanel) and
 * the step carries the canvas card — a bordered document card (icon, title,
 * "Texte") that opens the canvas panel, exactly like the reference.
 */
export const CanvasRenderer: MessageRenderer<
  ResearchAgentPacket,
  FullChatState
> = ({ packets, messageNodeId, stopPacketSeen, renderType, children }) => {
  const t = useTranslations("chat.messages.timeline");

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

  const isStreaming = !isComplete;

  const statusText = isComplete
    ? t("canvas.generated.status")
    : t("canvas.creating.status");

  const openCanvasPanel = () => {
    if (!title) return;
    useCanvasStore.getState().open({
      nodeId: messageNodeId ?? -1,
      title,
      content,
      isStreaming: !isComplete,
    });
  };

  // The canvas card — the reference document card (border, icon, title,
  // "Texte" subtitle, expand button). Same shape in every render mode:
  // the card is compact and the content lives in the side panel.
  const canvasCard = (
    <div
      role="button"
      tabIndex={0}
      aria-label={t("canvas.card.openAction")}
      onClick={openCanvasPanel}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openCanvasPanel();
        }
      }}
      className="group my-1 flex w-full cursor-pointer items-center gap-3 rounded-12 border border-border-strong bg-background-tint-00 px-3 py-2.5 text-start transition-colors hover:bg-action-selection-02 focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-8 border border-border-weak bg-background-tint-01">
        <SvgFileText className="h-4.5 w-4.5 stroke-text-03" />
      </div>
      <div className="min-w-0 flex-1">
        <Text as="span" text03 className="block truncate">
          {title || t("canvas.card.fallbackTitle")}
        </Text>
        <Text as="span" text04 mainUiMuted className="block truncate text-xs">
          {t("canvas.card.subtitle")}
        </Text>
      </div>
      <Button
        prominence="tertiary"
        size="sm"
        icon={SvgMaximize2}
        tooltip={t("canvas.card.openAction")}
        onClick={(e) => {
          e.stopPropagation();
          openCanvasPanel();
        }}
      />
    </div>
  );

  if (renderType === RenderType.HIGHLIGHT) {
    return children([
      {
        icon: null,
        status: null,
        content: (
          <div className="ps-(--timeline-common-text-padding)">
            {canvasCard}
          </div>
        ),
        supportsCollapsible: true,
        timelineLayout: "content",
      },
    ]);
  }

  return children([
    {
      icon: SvgFileText,
      status: statusText,
      content: (
        <div className="relative flex flex-col">
          {isStreaming && (
            <div className="ps-(--timeline-common-text-padding) pb-1">
              <Text as="span" text04 mainUiMuted>
                {t("canvas.creating.status")}
              </Text>
            </div>
          )}
          {canvasCard}
        </div>
      ),
      noPaddingRight: true,
      supportsCollapsible: true,
      timelineLayout: "content",
    },
  ]);
};
