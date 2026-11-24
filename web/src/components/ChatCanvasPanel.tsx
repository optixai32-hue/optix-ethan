"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { IconLoader } from "@opal/loaders";
import {
  Button,
  CopyButton,
  Text,
} from "@opal/components";
import {
  SvgDownload,
  SvgEdit,
  SvgFileText,
  SvgGlobe,
  SvgX,
} from "@opal/icons";
import { cn } from "@opal/utils";

import MinimalMarkdown from "@/components/chat/MinimalMarkdown";
import type { Components } from "react-markdown";
import { getLatestMessageChain } from "@/app/app/services/messageTree";
import { extractCanvasFromMessage } from "@/app/app/services/canvasUtils";
import { useCanvasStore } from "@/app/app/stores/useCanvasStore";
import {
  useChatSessionStore,
  useCurrentChatState,
  useCurrentMessageTree,
} from "@/app/app/stores/useChatSessionStore";

/** Locale code -> English language name for the translate prompt. */
const LOCALE_LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  fr: "French",
  de: "German",
  es: "Spanish",
  pt: "Portuguese",
  ko: "Korean",
  ja: "Japanese",
  zh: "Chinese",
  ar: "Arabic",
};

/** Document-flavored markdown components (the canvas is a document, not a chat bubble). */
const DOCUMENT_COMPONENTS = {
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="font-heading-h1 text-text-02 mt-6 mb-3 first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="font-heading-h2 text-text-02 mt-6 mb-2">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="font-heading-h3 text-text-03 mt-5 mb-2">{children}</h3>
  ),
  p: ({ children, dir }: { children?: React.ReactNode; dir?: string }) => (
    <p dir={dir} className="text-text-03 my-3 leading-relaxed">
      {children}
    </p>
  ),
  em: ({ children }: { children?: React.ReactNode }) => (
    <em className="text-text-04">{children}</em>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-text-02">{children}</strong>
  ),
  li: ({ children, dir }: { children?: React.ReactNode; dir?: string }) => (
    <li dir={dir} className="text-text-03 my-1 leading-relaxed">
      {children}
    </li>
  ),
  a: ({
    children,
    href,
  }: {
    children?: React.ReactNode;
    href?: string;
  }) => (
    <a
      href={href}
      className="text-text-04 underline underline-offset-2"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-4 overflow-x-auto rounded-12 border border-border-weak">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border-b border-border-weak bg-background-tint-01 px-3 py-2 text-start font-semibold text-text-03">
      {children}
    </th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border-b border-border-weak px-3 py-2 align-top text-text-03">
      {children}
    </td>
  ),
} satisfies Partial<Components>;

/**
 * ChatCanvasPanel — the Deep Search canvas side panel (chat + canvas split
 * view). Sits as a flex sibling of the chat column (AppChrome) and takes the
 * right half of the screen while a Deep Search canvas exists, like the
 * reference: the document streams live into the panel, the chat stays on the
 * left, and the panel carries its own floating toolbar
 * (edit / copy / download / translate / close).
 *
 * The stream watcher lives here: while the latest assistant message streams a
 * canvas (research_agent_start "Canvas : …" + intermediate_report deltas), the
 * panel auto-opens once for that message and follows the document live. The
 * canvas step card in the timeline can reopen it for any canvas (including
 * completed ones replayed from a persisted session).
 */
export function ChatCanvasPanel() {
  const t = useTranslations("chat.canvasPanel");
  const locale = useLocale();

  const visible = useCanvasStore((s) => s.visible);
  const title = useCanvasStore((s) => s.title);
  const content = useCanvasStore((s) => s.content);
  const isStreaming = useCanvasStore((s) => s.isStreaming);
  const open = useCanvasStore((s) => s.open);
  const close = useCanvasStore((s) => s.close);
  const streamUpdate = useCanvasStore((s) => s.streamUpdate);
  const setContent = useCanvasStore((s) => s.setContent);
  const markAutoOpened = useCanvasStore((s) => s.markAutoOpened);

  const currentSessionId = useChatSessionStore((s) => s.currentSessionId);
  const chatState = useCurrentChatState();
  const messageTree = useCurrentMessageTree();

  // ---- Stream watcher: extract the canvas of the latest message ----
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

  // Auto-open (once per message) + live refresh while the canvas streams.
  useEffect(() => {
    if (!canvas) return;
    const state = useCanvasStore.getState();
    if (
      canvas.isStreaming &&
      state.autoOpenedNodeId !== canvas.nodeId &&
      state.dismissedNodeId !== canvas.nodeId
    ) {
      open(canvas);
      markAutoOpened(canvas.nodeId);
      return;
    }
    if (canvas.isStreaming || canvas.nodeId === state.nodeId) {
      streamUpdate(canvas);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store reads go through getState()
  }, [canvas]);

  // Session switch: panel down, state cleared.
  useEffect(() => {
    useCanvasStore.getState().reset();
  }, [currentSessionId]);

  // ---- Panel UI ----
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [isTranslating, setIsTranslating] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);

  const scrollBodyRef = useRef<HTMLDivElement>(null);
  // Follow the stream (auto-scroll) unless the user scrolled away from the bottom.
  const followStreamRef = useRef(true);

  const displayContent = isEditing ? draft : content;

  // Keep pinned to the bottom while the document streams in.
  useEffect(() => {
    if (!visible || !isStreaming || isEditing) return;
    if (followStreamRef.current && scrollBodyRef.current) {
      scrollBodyRef.current.scrollTop = scrollBodyRef.current.scrollHeight;
    }
  }, [visible, isStreaming, isEditing, content]);

  const handleBodyScroll = useCallback(() => {
    const el = scrollBodyRef.current;
    if (!el) return;
    followStreamRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  const startEditing = useCallback(() => {
    setDraft(content);
    setIsEditing(true);
  }, [content]);

  const saveEditing = useCallback(async () => {
    setIsEditing(false);
    setContent(draft);
    // Best-effort persistence: find the session's canvas artifact by title
    // and PATCH its content.
    const sessionId = useChatSessionStore.getState().currentSessionId;
    if (!sessionId) return;
    try {
      const listRes = await fetch(
        `/api/artifacts?chat_session_id=${encodeURIComponent(sessionId)}`,
      );
      if (!listRes.ok) return;
      const data = await listRes.json();
      const artifact = (data?.artifacts ?? []).find(
        (a: { title?: string }) => a?.title === title,
      );
      if (artifact?.id) {
        await fetch(`/api/artifacts/${encodeURIComponent(artifact.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: draft }),
        });
      }
    } catch {
      // Persistence is optional — the edit already lives in the panel state.
    }
  }, [draft, setContent, title]);

  const downloadCanvas = useCallback(() => {
    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = `${title.replace(/[^a-z0-9]/gi, "_").toLowerCase() || "canvas"}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } finally {
      URL.revokeObjectURL(url);
    }
  }, [content, title]);

  const translateCanvas = useCallback(async () => {
    if (isTranslating || !content.trim()) return;
    const language =
      LOCALE_LANGUAGE_NAMES[locale] ?? LOCALE_LANGUAGE_NAMES.en ?? "English";
    setIsTranslating(true);
    setTranslateError(null);
    try {
      const res = await fetch("/api/artifacts/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, language }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      if (typeof data?.content === "string" && data.content.trim()) {
        setContent(data.content);
      }
    } catch {
      setTranslateError(t("translate.error"));
    } finally {
      setIsTranslating(false);
    }
  }, [content, isTranslating, locale, setContent, t]);

  if (!visible) {
    return null;
  }

  return (
    <aside
      aria-label={t("panel.ariaLabel")}
      className="fixed inset-0 z-50 md:relative md:inset-auto md:z-auto flex h-full w-full md:w-1/2 min-w-0 flex-col border-s bg-background overflow-hidden shadow-2xl md:shadow-none"
    >
      {/* Slim document header — icon, title, streaming indicator, close */}
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border-weak bg-background px-4 py-3">
        <SvgFileText className="h-4 w-4 shrink-0 stroke-text-03" />
        <div className="min-w-0 flex-1">
          <Text as="span" className="block truncate">
            {title || t("panel.fallbackTitle")}
          </Text>
          <Text
            as="span"
            color="text-03"
            font="main-ui-muted"
            className="block truncate text-xs"
          >
            {isStreaming ? t("panel.writing") : t("panel.ready")}
          </Text>
        </div>
        {isStreaming && (
          <IconLoader className="h-4 w-4 shrink-0 animate-spin stroke-text-03" />
        )}
      </div>

      {/* Document body — the canvas streams live here */}
      <div
        ref={scrollBodyRef}
        onScroll={handleBodyScroll}
        className="relative min-h-0 flex-1 overflow-y-auto"
      >
        {isEditing ? (
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="h-full min-h-[60vh] w-full resize-none bg-transparent px-6 py-6 font-mono text-sm leading-relaxed text-text-02 outline-none md:px-10"
          />
        ) : (
          <div className="mx-auto w-full max-w-3xl px-6 py-6 md:px-10 md:py-10">
            {content.trim() ? (
              <MinimalMarkdown
                content={displayContent}
                streaming={isStreaming}
                components={DOCUMENT_COMPONENTS}
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
        )}
      </div>

      {/* Floating vertical toolbar on the panel's right edge — the reference canvas tools */}
      <div className="pointer-events-none absolute end-2 top-1/2 -translate-y-1/2">
        <div className="pointer-events-auto flex flex-col gap-1 rounded-12 border border-border-weak bg-background-tint-00 p-1 shadow-sm">
          {isEditing ? (
            <>
              <Button
                prominence="tertiary"
                size="sm"
                icon={SvgEdit}
                tooltip={t("toolbar.save")}
                onClick={saveEditing}
              />
              <Button
                prominence="tertiary"
                size="sm"
                icon={SvgX}
                tooltip={t("toolbar.cancelEdit")}
                onClick={() => setIsEditing(false)}
              />
            </>
          ) : (
            <>
              <Button
                prominence="tertiary"
                size="sm"
                icon={SvgEdit}
                tooltip={t("toolbar.edit")}
                onClick={startEditing}
              />
              <CopyButton
                prominence="tertiary"
                size="sm"
                getCopyText={() => content}
                tooltip={t("toolbar.copy")}
              />
              <Button
                prominence="tertiary"
                size="sm"
                icon={SvgDownload}
                tooltip={t("toolbar.download")}
                onClick={downloadCanvas}
              />
              <Button
                prominence="tertiary"
                size="sm"
                icon={isTranslating ? undefined : SvgGlobe}
                disabled={isTranslating}
                tooltip={t("toolbar.translate")}
                onClick={translateCanvas}
              >
                {isTranslating ? (
                  <IconLoader className="h-4 w-4 animate-spin stroke-text-03" />
                ) : null}
              </Button>
              <Button
                prominence="tertiary"
                size="sm"
                icon={SvgX}
                tooltip={t("toolbar.close")}
                onClick={close}
              />
            </>
          )}
        </div>
      </div>

      {translateError && (
        <div
          className={cn(
            "absolute bottom-4 start-1/2 -translate-x-1/2 rounded-12",
            "border border-border-weak bg-background-tint-01 px-3 py-2",
          )}
        >
          <Text as="span" color="text-03" font="main-ui-muted">
            {translateError}
          </Text>
        </div>
      )}
    </aside>
  );
}

export default ChatCanvasPanel;
