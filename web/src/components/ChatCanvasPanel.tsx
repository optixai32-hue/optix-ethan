"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { IconLoader } from "@opal/loaders";
import {
  Button,
  LineItemButton,
  Popover,
  PopoverMenu,
} from "@opal/components";
import {
  SvgArrowLeft,
  SvgArrowUpDown,
  SvgBubbleText,
  SvgGlobe,
  SvgListTree,
  SvgSparkle,
  SvgUsers,
  SvgX,
} from "@opal/icons";

import MinimalMarkdown from "@/components/chat/MinimalMarkdown";
import { getLatestMessageChain } from "@/app/app/services/messageTree";
import { extractCanvasFromMessage } from "@/app/app/services/canvasUtils";
import { useCanvasStore } from "@/app/app/stores/useCanvasStore";
import {
  useChatSessionStore,
  useCurrentChatState,
  useCurrentMessageTree,
} from "@/app/app/stores/useChatSessionStore";
import {
  CANVAS_DOCUMENT_COMPONENTS,
} from "@/components/canvas/canvasDocument";
import Text from "@/refresh-components/texts/Text";

/** One option of a toolbar dropdown (Format / Longueur / … / languages). */
interface ToolbarOption {
  key: string;
  /** Pill message the option submits (already localized). */
  action: string;
  /** Display label in the dropdown. */
  label: string;
}

/**
 * ChatCanvasPanel — the Deep Search canvas split view (the reference video's
 * "Agrandir" state): the chat keeps the left half, the full canvas document
 * fills the right panel, and the floating VERTICAL toolbar on the panel's
 * right edge carries the six canvas tools —
 *
 *   Ajouter la touche finale · Format · Longueur · Tonalité · Public · Traduire
 *
 * Every tool submits its pill message into the chat (文A "Traduire le texte
 * en anglais"), the bot thinks and answers, and the updated canvas document
 * streams back into the panel.
 *
 * The panel renders NOTHING unless a canvas is expanded: the original
 * layout is untouched when closed. Folding happens through the panel
 * header — the "Timeline" back action and the SvgX close button — or
 * Escape; the canvas card itself always stays in the message timeline.
 */
export function ChatCanvasPanel() {
  const t = useTranslations("chat.canvasPanel");
  const tTimeline = useTranslations("chat.messages.timeline");

  const visible = useCanvasStore((s) => s.visible);
  const title = useCanvasStore((s) => s.title);
  const content = useCanvasStore((s) => s.content);
  const isStreaming = useCanvasStore((s) => s.isStreaming);
  const close = useCanvasStore((s) => s.close);
  const streamUpdate = useCanvasStore((s) => s.streamUpdate);
  const enqueueAction = useCanvasStore((s) => s.enqueueAction);

  const currentSessionId = useChatSessionStore((s) => s.currentSessionId);
  const chatState = useCurrentChatState();
  const messageTree = useCurrentMessageTree();

  // ---- Stream watcher: follow the latest message's canvas while the panel
  // is open (the canvas action messages stream their updated canvas here).
  const latestMessage = useMemo(() => {
    if (!messageTree) return null;
    const chain = getLatestMessageChain(messageTree);
    return chain.length > 0 ? chain[chain.length - 1] : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- packets mutate in place; packetCount is the memo key (AgentMessage's memo does the same)
  }, [messageTree]);

  // Single-model streams never set message.is_generating (multi-model only);
  // the session-level chatState is the reliable "still generating" signal.
  const sessionGenerating =
    !!latestMessage?.is_generating ||
    chatState === "streaming" ||
    chatState === "loading" ||
    chatState === "toolBuilding";

  const canvas = useMemo(
    () =>
      latestMessage
        ? extractCanvasFromMessage(latestMessage, sessionGenerating)
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
    [
      latestMessage?.nodeId,
      latestMessage?.packetCount,
      latestMessage?.is_generating,
      sessionGenerating,
    ],
  );

  // Live refresh while the panel is open (the card's "Agrandir" opens it;
  // there is no auto-open — the video always opens through Agrandir).
  useEffect(() => {
    if (!canvas || !visible) return;
    streamUpdate(canvas);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store reads go through getState()
  }, [canvas, visible]);

  // Session switch: panel down, state cleared.
  useEffect(() => {
    useCanvasStore.getState().reset();
  }, [currentSessionId]);

  // Escape folds the panel back into the timeline card.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, close]);

  // ---- Panel UI state ----
  const scrollBodyRef = useRef<HTMLDivElement>(null);
  // Follow the stream (auto-scroll) unless the user scrolled away from the bottom.
  const followStreamRef = useRef(true);

  // Keep pinned to the bottom while the document streams in.
  useEffect(() => {
    if (!visible || !isStreaming) return;
    if (followStreamRef.current && scrollBodyRef.current) {
      scrollBodyRef.current.scrollTop = scrollBodyRef.current.scrollHeight;
    }
  }, [visible, isStreaming, content]);

  const handleBodyScroll = useCallback(() => {
    const el = scrollBodyRef.current;
    if (!el) return;
    followStreamRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  // ---- Toolbar dropdowns (the reference video's canvas tools) ----
  const [openMenu, setOpenMenu] = useState<
    "format" | "length" | "tone" | "audience" | "translate" | null
  >(null);

  const languageOptions: ToolbarOption[] = useMemo(
    () => [
      { key: "zh", label: t("options.languages.chinese"), action: t("actions.translateInto", { language: t("options.languages.chinese") }) },
      { key: "en", label: t("options.languages.english"), action: t("actions.translateInto", { language: t("options.languages.english") }) },
      { key: "fr", label: t("options.languages.french"), action: t("actions.translateInto", { language: t("options.languages.french") }) },
      { key: "de", label: t("options.languages.german"), action: t("actions.translateInto", { language: t("options.languages.german") }) },
      { key: "el", label: t("options.languages.greek"), action: t("actions.translateInto", { language: t("options.languages.greek") }) },
      { key: "ru", label: t("options.languages.russian"), action: t("actions.translateInto", { language: t("options.languages.russian") }) },
      { key: "es", label: t("options.languages.spanish"), action: t("actions.translateInto", { language: t("options.languages.spanish") }) },
    ],
    [t],
  );

  const formatOptions: ToolbarOption[] = useMemo(
    () => [
      { key: "report", label: t("options.format.report"), action: t("actions.formatAs", { option: t("options.format.report") }) },
      { key: "brief", label: t("options.format.brief"), action: t("actions.formatAs", { option: t("options.format.brief") }) },
      { key: "bullets", label: t("options.format.bullets"), action: t("actions.formatAs", { option: t("options.format.bullets") }) },
    ],
    [t],
  );

  const lengthOptions: ToolbarOption[] = useMemo(
    () => [
      { key: "shorter", label: t("options.length.shorter"), action: t("actions.shorten") },
      { key: "longer", label: t("options.length.longer"), action: t("actions.lengthen") },
    ],
    [t],
  );

  const toneOptions: ToolbarOption[] = useMemo(
    () => [
      { key: "professional", label: t("options.tone.professional"), action: t("actions.tone", { option: t("options.tone.professional") }) },
      { key: "neutral", label: t("options.tone.neutral"), action: t("actions.tone", { option: t("options.tone.neutral") }) },
      { key: "conversational", label: t("options.tone.conversational"), action: t("actions.tone", { option: t("options.tone.conversational") }) },
    ],
    [t],
  );

  const audienceOptions: ToolbarOption[] = useMemo(
    () => [
      { key: "general", label: t("options.audience.general"), action: t("actions.audience", { option: t("options.audience.general") }) },
      { key: "experts", label: t("options.audience.experts"), action: t("actions.audience", { option: t("options.audience.experts") }) },
      { key: "students", label: t("options.audience.students"), action: t("actions.audience", { option: t("options.audience.students") }) },
    ],
    [t],
  );

  const submitAction = useCallback(
    (action: string) => {
      enqueueAction(action);
      setOpenMenu(null);
    },
    [enqueueAction],
  );

  const finishingTouchAction = useMemo(
    () => t("actions.finishingTouch"),
    [t],
  );

  /** A dropdown-opening toolbar button (its options submit pill messages). */
  const toolbarDropdown = (
    menuKey: NonNullable<typeof openMenu>,
    icon: React.ComponentType<{ className?: string }>,
    tooltip: string,
    options: ToolbarOption[],
  ) => (
    <Popover
      open={openMenu === menuKey}
      onOpenChange={(next) => setOpenMenu(next ? menuKey : null)}
    >
      <Popover.Trigger asChild>
        <Button
          prominence="tertiary"
          size="sm"
          icon={icon as never}
          tooltip={tooltip}
          aria-label={tooltip}
        />
      </Popover.Trigger>
      <Popover.Content side="left" align="center" width={56} padding={1}>
        <div className="px-1 py-1">
          <PopoverMenu>
            {options.map((option) => (
              <LineItemButton
                key={option.key}
                sizePreset="main-ui"
                variant="section"
                title={option.label}
                onClick={() => submitAction(option.action)}
              />
            ))}
          </PopoverMenu>
        </div>
      </Popover.Content>
    </Popover>
  );

  if (!visible) {
    return null;
  }

  return (
    <aside
      aria-label={t("panel.ariaLabel")}
      className="fixed inset-0 z-50 md:relative md:inset-auto md:z-auto flex h-full w-full md:w-1/2 min-w-0 flex-col border-s border-border-weak bg-background overflow-hidden shadow-2xl md:shadow-none"
    >
      {/* Panel header — the reference video's split view: the "Timeline"
          back action folds the panel (the canvas card stays in the chat's
          timeline), the SvgX button closes it the same way. */}
      <div className="flex shrink-0 items-center justify-between border-b border-border-weak px-4 py-2">
        <button
          type="button"
          onClick={close}
          aria-label={t("header.timeline")}
          className="flex items-center gap-1.5 rounded-8 px-1.5 py-1 text-sm text-text-03 transition-colors hover:bg-action-selection-02 hover:text-text-01 focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <SvgArrowLeft className="h-4 w-4" />
          {t("header.timeline")}
        </button>
        <Button
          prominence="tertiary"
          size="sm"
          icon={SvgX}
          tooltip={tTimeline("canvas.card.foldAction")}
          aria-label={tTimeline("canvas.card.foldAction")}
          onClick={close}
        />
      </div>

      {/* Document body — the full canvas streams/renders here (the video's
          panel carries no title: the document's own H1 is the title). */}
      <div
        ref={scrollBodyRef}
        onScroll={handleBodyScroll}
        className="relative min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-3xl px-6 py-8 md:px-10 md:py-10">
          {content.trim() ? (
            <MinimalMarkdown
              content={content}
              streaming={isStreaming}
              components={CANVAS_DOCUMENT_COMPONENTS}
            />
          ) : (
            <div className="flex items-center gap-2 py-16">
              <IconLoader className="h-4 w-4 animate-spin stroke-text-03" />
              <Text as="p" color="text-03" font="main-ui-muted">
                {t("panel.writing")}
              </Text>
            </div>
          )}
        </div>
      </div>

      {/* Streaming indicator — the small floating badge while the canvas
          writes (the video's panel is quiet once the document is ready). */}
      {isStreaming && (
        <div className="pointer-events-none absolute start-4 top-4 flex items-center gap-2 rounded-full border border-border-weak bg-background-tint-00 px-2.5 py-1">
          <IconLoader className="h-3.5 w-3.5 animate-spin stroke-text-03" />
          <Text as="span" color="text-03" font="main-ui-muted">
            {t("panel.writing")}
          </Text>
        </div>
      )}

      {/* The floating VERTICAL toolbar on the panel's right edge — the
          reference video's six canvas tools, each with its tooltip. */}
      <div className="pointer-events-none absolute end-2 top-1/2 -translate-y-1/2">
        <div className="pointer-events-auto flex flex-col gap-1 rounded-12 border border-border-weak bg-background-tint-00 p-1 shadow-sm">
          <Button
            prominence="tertiary"
            size="sm"
            icon={SvgSparkle}
            tooltip={t("toolbar.finishingTouch")}
            aria-label={t("toolbar.finishingTouch")}
            onClick={() => submitAction(finishingTouchAction)}
          />
          {toolbarDropdown(
            "format",
            SvgListTree,
            t("toolbar.format"),
            formatOptions,
          )}
          {toolbarDropdown(
            "length",
            SvgArrowUpDown,
            t("toolbar.length"),
            lengthOptions,
          )}
          {toolbarDropdown(
            "tone",
            SvgBubbleText,
            t("toolbar.tone"),
            toneOptions,
          )}
          {toolbarDropdown(
            "audience",
            SvgUsers,
            t("toolbar.audience"),
            audienceOptions,
          )}
          {toolbarDropdown(
            "translate",
            SvgGlobe,
            t("toolbar.translate"),
            languageOptions,
          )}
        </div>
      </div>

    </aside>
  );
}

export default ChatCanvasPanel;
