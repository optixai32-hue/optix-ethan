"use client";

import type { Components } from "react-markdown";

/**
 * Document-flavored markdown components shared by the Deep Search canvas
 * surfaces (the timeline card preview and the side panel): the canvas is a
 * document, not a chat bubble — headings and tables render like a page.
 */
export const CANVAS_DOCUMENT_COMPONENTS = {
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

/** Download the canvas document as a markdown file. */
export function downloadCanvasDocument(title: string, content: string): void {
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
}
