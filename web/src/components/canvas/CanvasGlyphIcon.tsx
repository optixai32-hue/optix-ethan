"use client";

/**
 * CanvasGlyphIcon — the Deep Search canvas glyph: the small rounded-square
 * "文A" badge used by the canvas card, the collapsed pill, and the canvas
 * action pill (the reference video's canvas document icon).
 *
 * Renders the "文A" glyph inside a rounded square; the color follows the
 * current text color (text- utilities on the parent).
 */
export function CanvasGlyphIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="2.75"
        y="2.75"
        width="18.5"
        height="18.5"
        rx="4.5"
        fill="currentColor"
        opacity="0.14"
      />
      <rect
        x="2.75"
        y="2.75"
        width="18.5"
        height="18.5"
        rx="4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        opacity="0.45"
      />
      <text
        x="12"
        y="15.6"
        textAnchor="middle"
        fontSize="9.2"
        fontWeight="700"
        fill="currentColor"
        fontFamily="system-ui, -apple-system, 'Segoe UI', sans-serif"
      >
        文A
      </text>
    </svg>
  );
}

export default CanvasGlyphIcon;
