"use client";

import React, { useEffect, useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import { SvgDownload, SvgEdit } from "@opal/icons";
import { Button, CopyButton } from "@opal/components";

import MinimalMarkdown from "@/components/chat/MinimalMarkdown";
import { Packet } from "@/app/app/services/streamingModels";
import { extractCanvasFromPackets } from "@/app/app/services/canvasUtils";
import { useCanvasStore } from "@/app/app/stores/useCanvasStore";
import { CanvasGlyphIcon } from "@/components/canvas/CanvasGlyphIcon";
import {
  CANVAS_DOCUMENT_COMPONENTS,
  downloadCanvasDocument,
} from "@/components/canvas/canvasDocument";
import Text from "@/refresh-components/texts/Text";

/**
 * CanvasInlineCard — the Deep Search canvas document card floating FREE in the
 * message flow, BELOW the step pile (the reference video's card is never
 * wrapped in a step pill).
 *
 * It is mounted by AgentMessage between the timeline and the final answer, so:
 *  - it carries no step chrome (no icon rail, no status header, no surface) —
 *    the pile keeps only a slim "Modifié un Canvas · Effectué N recherches"
 *    status row (CanvasRenderer);
 *  - it streams live while the canvas writes ("Création du Canvas…");
 *  - it stays visible even after the steps collapse back into the "N steps"
 *    pill — the card never folds away.
 *
 * Renders nothing when the message carries no canvas packets.
 */
export function CanvasInlineCard({
  packets,
  nodeId,
  stopPacketSeen,
}: {
  packets: Packet[];
  nodeId: number;
  stopPacketSeen: boolean;
}) {
  const t = useTranslations("chat.messages.timeline");
  const openCanvasPanel = useCanvasStore((s) => s.open);

  // The message's CURRENT canvas: extractCanvasFromPackets walks the whole
  // message and keeps the LAST canvas start — a content-filter restart or a
  // later panel action (refine/translate) supersedes every earlier attempt.
  // rawPackets mutates in place, so packets.length is the memo key
  // (AgentMessage re-renders on packet growth and this component is not
  // memoized, so the card follows the stream).
  const canvas = useMemo(
    () => extractCanvasFromPackets(packets, nodeId, !stopPacketSeen),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- packets mutate in place; length is the change-detection key (AgentMessage's memo does the same)
    [packets.length, nodeId, stopPacketSeen],
  );

  const previewScrollRef = useRef<HTMLDivElement>(null);
  // Follow the live stream inside the preview (pinned to the bottom).
  useEffect(() => {
    if (!canvas?.isStreaming) return;
    if (previewScrollRef.current) {
      previewScrollRef.current.scrollTop =
        previewScrollRef.current.scrollHeight;
    }
  }, [canvas]);

  if (!canvas) return null;

  const handleExpand = () => {
    openCanvasPanel({
      nodeId: canvas.nodeId,
      title: canvas.title,
      content: canvas.content,
      isStreaming: canvas.isStreaming,
    });
  };

  return (
    <div className="flex w-full flex-col rounded-12 border border-border-weak bg-background-tint-00 text-start">
      {/* Card header — the video's icon + title + Modifier / Copier / download */}
      <div className="flex items-center gap-2.5 border-b border-border-weak px-3 py-2.5">
        <CanvasGlyphIcon className="h-5 w-5 shrink-0 text-text-02" />
        <Text as="span" text03 className="min-w-0 flex-1 truncate">
          {canvas.title || t("canvas.card.fallbackTitle")}
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
            getCopyText={() => canvas.content}
            tooltip={t("canvas.card.copy")}
          />
          <Button
            prominence="tertiary"
            size="sm"
            icon={SvgDownload}
            tooltip={t("canvas.card.download")}
            onClick={() => downloadCanvasDocument(canvas.title, canvas.content)}
          />
        </div>
      </div>

      {/* Card body — the live document preview */}
      <div
        ref={previewScrollRef}
        className="max-h-72 min-h-16 overflow-y-auto px-4 py-3"
      >
        {canvas.content.trim() ? (
          <MinimalMarkdown
            content={canvas.content}
            streaming={canvas.isStreaming}
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
}

export default CanvasInlineCard;
