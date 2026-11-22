/**
 * Chunking — TypeScript port of the Onyx chunking layer:
 *   backend/onyx/indexing/chunker.py              (Chunker orchestration, L124)
 *   backend/onyx/indexing/chunking/document_chunker.py       (section accumulator)
 *   backend/onyx/indexing/chunking/text_section_chunker.py   (TextChunker L22:
 *      sections merged with SECTION_SEPARATOR; oversized sections delegated to
 *      a sentence splitter with token overlap)
 *   backend/onyx/configs/constants.py             (SECTION_SEPARATOR = "\n\n")
 *
 * The Python implementation uses `chonkie.SentenceChunker` for oversized
 * sections; here the same priority ladder is implemented directly on top of
 * gpt-tokenizer (o200k_base):
 *     section ("\n\n") -> paragraph ("\n") -> sentence (".!?") -> hard token split
 * Whole sections are merged into one chunk while they fit (accumulator
 * semantics of text_section_chunker.py — no overlap between merged sections);
 * overlap (DEFAULT_CHUNK_OVERLAP) applies only inside a single oversized
 * section's windows, exactly where the Python SentenceChunker applied it.
 */
import { decode, encode } from "gpt-tokenizer";
import { DEFAULT_CHUNK_OVERLAP, DEFAULT_CHUNK_SIZE } from "../configs/constants.js";

/** Token count using the o200k_base tokenizer (BaseTokenizer.encode in Onyx). */
export function tokenizeCount(text: string): number {
  if (text.length === 0) return 0;
  return encode(text).length;
}

/** Port of onyx/utils/text_processing.py clean_text (unicode hygiene). */
function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[\u200b\u200c\u200d]/g, "");
}

function splitParagraphs(text: string): string[] {
  return text
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Sentence split — the TS equivalent of chonkie's sentence-boundary detection:
 * keep terminal punctuation attached to the preceding sentence; a final
 * unterminated tail remains its own unit.
 */
function splitSentences(text: string): string[] {
  const matches = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g);
  if (!matches) return text.trim().length > 0 ? [text.trim()] : [];
  return matches
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Overlap-aware greedy packing of small units (mirror of SentenceChunker with
 * chunk_size=maxTokens, chunk_overlap=overlapTokens, joiner = the separator
 * used at the current split level).
 */
function packUnitsWithOverlap(
  units: string[],
  maxTokens: number,
  overlapTokens: number,
  joiner: string,
): string[] {
  const sepCost = tokenizeCount(joiner);
  const windows: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    const windowText = current.join(joiner);
    windows.push(windowText);
    // Carry the tail of the flushed window as the next window's overlap.
    if (overlapTokens > 0) {
      const tokens = encode(windowText);
      if (tokens.length > overlapTokens) {
        const overlapText = decode(tokens.slice(tokens.length - overlapTokens));
        current = [overlapText];
        currentTokens = tokenizeCount(overlapText);
        return;
      }
      // Whole window is smaller than the overlap — restarting empty is safer
      // than duplicating everything.
    }
    current = [];
    currentTokens = 0;
  };

  for (const unit of units) {
    const unitTokens = tokenizeCount(unit);
    if (unitTokens === 0) continue;
    const addCost = current.length > 0 ? sepCost + unitTokens : unitTokens;
    if (current.length > 0 && currentTokens + addCost > maxTokens) {
      flush();
      if (current.length > 0 && currentTokens + sepCost + unitTokens > maxTokens) {
        // Overlap consumed too much of the budget for this unit — drop it.
        current = [];
        currentTokens = 0;
      }
    }
    current.push(unit);
    currentTokens += current.length > 1 ? sepCost + unitTokens : unitTokens;
  }
  if (current.length > 0) windows.push(current.join(joiner));
  return windows;
}

/** Hard token split with overlap — last-resort leaf of the split ladder. */
function hardTokenSplit(
  text: string,
  maxTokens: number,
  overlapTokens: number,
): string[] {
  const tokens = encode(text);
  if (tokens.length <= maxTokens) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < tokens.length) {
    const end = Math.min(start + maxTokens, tokens.length);
    chunks.push(decode(tokens.slice(start, end)));
    if (end >= tokens.length) break;
    const next = end - overlapTokens;
    start = next > start ? next : end; // guarantee forward progress
  }
  return chunks;
}

/**
 * Recursive oversized-section splitter: paragraph -> sentence -> hard split,
 * packing the resulting units with overlap at each level.
 */
function splitOversized(
  text: string,
  maxTokens: number,
  overlapTokens: number,
): string[] {
  if (tokenizeCount(text) <= maxTokens) return [text.trim()];

  const paragraphs = splitParagraphs(text);
  if (paragraphs.length > 1) {
    const units = paragraphs.flatMap((p) => splitOversized(p, maxTokens, overlapTokens));
    return packUnitsWithOverlap(units, maxTokens, overlapTokens, "\n");
  }

  const sentences = splitSentences(text);
  if (sentences.length > 1) {
    const units = sentences.flatMap((s) => splitOversized(s, maxTokens, overlapTokens));
    return packUnitsWithOverlap(units, maxTokens, overlapTokens, " ");
  }

  return hardTokenSplit(text.trim(), maxTokens, overlapTokens);
}

export interface ChunkOptions {
  /** Max tokens per chunk (Onyx DOC_EMBEDDING_CONTEXT_SIZE / our DEFAULT_CHUNK_SIZE). */
  maxTokens?: number;
  /** Overlap between windows of one oversized section (Onyx CHUNK_OVERLAP). */
  overlapTokens?: number;
}

/**
 * Port of Chunker._handle_single_document + TextChunker.chunk_section:
 * split into sections on "\n\n" (SECTION_SEPARATOR), merge adjacent sections
 * while they fit within `maxTokens`, split oversized sections via the
 * paragraph/sentence/hard-token ladder with token overlap.
 */
export function chunkText(text: string, opts?: ChunkOptions): string[] {
  const maxTokens = opts?.maxTokens ?? DEFAULT_CHUNK_SIZE;
  const overlapTokens = opts?.overlapTokens ?? DEFAULT_CHUNK_OVERLAP;
  if (maxTokens < 1) throw new Error("maxTokens must be >= 1");
  // An overlap >= maxTokens would stall packing; clamp like SentenceChunker.
  const effOverlap = Math.min(overlapTokens, Math.max(0, maxTokens - 1));

  const cleaned = cleanText(text).trim();
  if (cleaned.length === 0) return [];

  const sections = cleaned
    .split("\n\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sections.length === 0) return [];

  const sepCost = tokenizeCount("\n\n");
  const chunks: string[] = [];
  let buffer: string[] = [];
  let bufferTokens = 0;

  for (const section of sections) {
    const sectionTokens = tokenizeCount(section);
    if (sectionTokens > maxTokens) {
      // Oversized — flush the buffer, then split this section (L82 of
      // text_section_chunker.py _handle_oversized_section).
      if (buffer.length > 0) {
        chunks.push(buffer.join("\n\n"));
        buffer = [];
        bufferTokens = 0;
      }
      chunks.push(...splitOversized(section, maxTokens, effOverlap));
      continue;
    }
    const addCost = buffer.length > 0 ? sepCost + sectionTokens : sectionTokens;
    if (buffer.length > 0 && bufferTokens + addCost > maxTokens) {
      // Doesn't fit — flush buffer and restart with this section.
      chunks.push(buffer.join("\n\n"));
      buffer = [section];
      bufferTokens = sectionTokens;
    } else {
      // Fits — extend the accumulator.
      buffer.push(section);
      bufferTokens += addCost;
    }
  }
  // Final flush.
  if (buffer.length > 0) chunks.push(buffer.join("\n\n"));

  return chunks;
}

// ---------------------------------------------------------------------------
// Section-aware chunking (used by the indexing pipeline to keep section links)
// ---------------------------------------------------------------------------

export interface SectionInput {
  text: string;
  link?: string;
}

export interface SectionedChunk {
  content: string;
  /** Source link of the first section merged into this chunk (Onyx keeps
   *  per-offset link maps; the mini-service metadata carries the primary one). */
  link?: string;
}

/**
 * Accumulator chunking over typed sections — direct port of
 * DocumentChunker._collect_section_payloads + TextChunker.chunk_section
 * (text_section_chunker.py L36-80): sections merge while they fit, oversized
 * sections flush the buffer and are split with overlap; every emitted chunk
 * carries the link of its first constituent section.
 */
export function chunkSectionsWithLinks(
  sections: SectionInput[],
  opts?: ChunkOptions,
): SectionedChunk[] {
  const maxTokens = opts?.maxTokens ?? DEFAULT_CHUNK_SIZE;
  const overlapTokens = opts?.overlapTokens ?? DEFAULT_CHUNK_OVERLAP;
  const effOverlap = Math.min(overlapTokens, Math.max(0, maxTokens - 1));
  const sepCost = tokenizeCount("\n\n");

  const chunks: SectionedChunk[] = [];
  let buffer: { text: string; link?: string }[] = [];
  let bufferTokens = 0;

  const flushBuffer = (): void => {
    if (buffer.length === 0) return;
    chunks.push({ content: buffer.map((b) => b.text).join("\n\n"), link: buffer[0].link });
    buffer = [];
    bufferTokens = 0;
  };

  for (const section of sections) {
    const text = cleanText(section.text ?? "").trim();
    if (text.length === 0) continue;
    const sectionTokens = tokenizeCount(text);
    if (sectionTokens > maxTokens) {
      flushBuffer();
      for (const piece of splitOversized(text, maxTokens, effOverlap)) {
        chunks.push({ content: piece, link: section.link });
      }
      continue;
    }
    const addCost = buffer.length > 0 ? sepCost + sectionTokens : sectionTokens;
    if (buffer.length > 0 && bufferTokens + addCost > maxTokens) {
      flushBuffer();
      buffer = [{ text, link: section.link }];
      bufferTokens = sectionTokens;
    } else {
      buffer.push({ text, link: section.link });
      bufferTokens += addCost;
    }
  }
  flushBuffer();
  return chunks;
}
