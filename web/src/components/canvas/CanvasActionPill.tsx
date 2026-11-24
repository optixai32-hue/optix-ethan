"use client";

import Text from "@/refresh-components/texts/Text";
import { CanvasGlyphIcon } from "@/components/canvas/CanvasGlyphIcon";

/**
 * CanvasActionPill — the compact pill a canvas toolbar action submits into
 * the chat (the reference video: click a language under "Traduire" and the
 * message 文A "Traduire le texte en anglais" appears in the chat, then the
 * bot thinks and answers).
 *
 * Rendered in place of the standard user message bubble for `[canvas] `
 * messages (see ChatUI) — an additive branch, the original bubble is
 * untouched for every other message.
 */
export function CanvasActionPill({ text }: { text: string }) {
  return (
    <div className="flex w-full justify-end">
      <div
        className="inline-flex max-w-[85%] items-center gap-2 rounded-full border border-border-strong bg-background-tint-00 px-3 py-1.5"
        role="status"
      >
        <CanvasGlyphIcon className="h-4.5 w-4.5 shrink-0 text-text-02" />
        <Text as="span" text03 className="truncate">
          {text}
        </Text>
      </div>
    </div>
  );
}

export default CanvasActionPill;
