/**
 * Citations — TypeScript port of:
 *   - backend/onyx/chat/citation_processor.py (DynamicCitationProcessor +
 *     CodeFenceTracker, token-level citation extraction with modes
 *     REMOVE / KEEP_MARKERS / HYPERLINK, seen-citation tracking, ordered
 *     cited-document list, deduplication of recently cited documents)
 *   - backend/onyx/chat/citation_utils.py (extract_citation_order_from_text +
 *     collapse_citations — renumbering citations to the smallest available
 *     numbers while reusing numbers of already-known documents)
 *
 * Regexes are translated 1:1 from the Python source, including the linear-safe
 * comma-separated inner group of `possible_citation_pattern` (the Python
 * comment at citation_processor.py lines 327-335 documents why the nested
 * quantifier form must NOT be used — it causes catastrophic backtracking).
 *
 * The final answer-to-Citation[] mapping (document_id, semantic_identifier,
 * link, blurb, source_type, chunk_id) applies the same dedupe/renumber rules:
 * one Citation per unique document, ordered by first citation appearance.
 */

import type { Citation, SearchDoc } from "../types/domain";

export type CitationMode = "REMOVE" | "KEEP_MARKERS" | "HYPERLINK";

/** Emitted alongside text while streaming in HYPERLINK mode. */
export interface CitationInfoEvent {
  citation_number: number;
  document_id: string;
}

export type CitationStreamItem = string | CitationInfoEvent;

export type CitationMapping = Map<number, SearchDoc>;

// ============================================================================
// Utility functions (port of citation_processor.py lines 47-87)
// ============================================================================

const QUOTE_MARKER = /^ {0,3}> ?/;
const LIST_MARKER = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;
const FENCE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;

function stripQuotes(line: string, maxDepth?: number): [number, string] {
  let depth = 0;
  let current = line;
  while (maxDepth === undefined || depth < maxDepth) {
    const match = QUOTE_MARKER.exec(current);
    if (!match) break;
    current = current.slice(match[0].length);
    depth += 1;
  }
  return [depth, current];
}

/** Column width with CommonMark tab stops (multiples of 4). */
function width(text: string): number {
  let column = 0;
  for (const char of text) {
    column = char === "\t" ? column + 4 - (column % 4) : column + 1;
  }
  return column;
}

function indent(text: string): number {
  const stripped = text.length - text.replace(/^[ \t]+/, "").length;
  return width(text.slice(0, stripped));
}

interface OpenFence {
  fence: string;
  quoteDepth: number;
  /** Content column of the enclosing list item (0 outside lists). */
  base: number;
}

/**
 * Line-aware tracker of fenced code blocks in streamed markdown.
 * Full port of CodeFenceTracker (citation_processor.py lines 83-190).
 */
export class CodeFenceTracker {
  private open: OpenFence | null = null;
  private partialLine = "";
  private lineStart = 0;
  private listColumn = 0;
  /** Offsets of lines that open or close a block, in order. */
  private transitions: number[] = [];

  feed(text: string): void {
    const lines = (this.partialLine + text).split("\n");
    this.partialLine = lines.pop() ?? "";
    for (const line of lines) {
      this.processLine(line);
      this.lineStart += line.length + 1;
    }
  }

  /** End of an LLM step: finish the pending line, close any open block. */
  flush(): void {
    this.processLine(this.partialLine);
    this.lineStart += this.partialLine.length;
    this.partialLine = "";
    this.listColumn = 0;
    if (this.open !== null) {
      this.setOpen(null);
    }
  }

  inCodeBlockAt(offset: number): boolean {
    if (offset >= this.lineStart && this.containerEnded(this.partialLine)) {
      return false;
    }
    // bisect_right(transitions, offset) % 2 == 1
    let lo = 0;
    let hi = this.transitions.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.transitions[mid] <= offset) lo = mid + 1;
      else hi = mid;
    }
    return lo % 2 === 1;
  }

  /** Whether `offset` sits in an unfinished line that may open a block. */
  mayOpenAt(offset: number): boolean {
    const line = this.partialLine;
    return (
      offset >= this.lineStart &&
      (this.open === null || this.containerEnded(line)) &&
      this.opening(line)[0] !== null
    );
  }

  private containerEnded(line: string): boolean {
    if (this.open === null) return false;
    const [depth, rest] = stripQuotes(line, this.open.quoteDepth);
    if (!rest.trim()) return depth < this.open.quoteDepth;
    return depth < this.open.quoteDepth || indent(rest) < this.open.base;
  }

  private processLine(line: string): void {
    if (this.open !== null) {
      if (this.containerEnded(line)) {
        this.setOpen(null);
        return;
      }
      const [, rest] = stripQuotes(line, this.open.quoteDepth);
      const match = FENCE.exec(rest);
      if (
        match &&
        indent(rest) <= this.open.base + 3 &&
        match[2][0] === this.open.fence[0] &&
        match[2].length >= this.open.fence.length &&
        !match[3].trim()
      ) {
        this.setOpen(null);
      }
      return;
    }
    const [opened, listColumn] = this.opening(line);
    this.listColumn = listColumn;
    if (opened !== null) {
      this.setOpen(opened);
    }
  }

  private opening(line: string): [OpenFence | null, number] {
    let listColumn = this.listColumn;
    const [depth, rest] = stripQuotes(line);
    if (!rest.trim()) return [null, listColumn];
    const marker = LIST_MARKER.exec(rest);
    let match: RegExpExecArray | null;
    if (marker) {
      listColumn = width(marker[0]);
      match = FENCE.exec(rest.slice(marker[0].length));
      if (match && match[1]) return [null, listColumn];
    } else {
      if (indent(rest) < listColumn) listColumn = 0;
      match = FENCE.exec(rest);
      // 4+ spaces past the container column is an indented code block.
      if (match && width(match[1]) > listColumn + 3) return [null, listColumn];
    }
    if (!match) return [null, listColumn];
    const fence = match[2];
    const info = match[3];
    // Backtick fences cannot have backticks in the info string.
    if (fence[0] === "`" && info.includes("`")) return [null, listColumn];
    return [{ fence, quoteDepth: depth, base: listColumn }, listColumn];
  }

  private setOpen(openFence: OpenFence | null): void {
    this.open = openFence;
    this.transitions.push(this.lineStart);
  }
}

// ============================================================================
// Main Citation Processor with Dynamic Mapping
// (port of DynamicCitationProcessor, citation_processor.py lines 198-777)
// ============================================================================

/**
 * Matches potential incomplete citations: '[', '[[', '[1', '[[1', '[1,', '[1, ',
 * plus unicode bracket variants. The inner group is the linear-safe
 * comma-separated form — do not "simplify" it back to a nested quantifier.
 */
const POSSIBLE_CITATION_PATTERN = /[[【［]+(?:\d+(?:, ?\d+)*(?:, ?)?)?$/;

/**
 * Matches complete citations:
 *   group 1: '[[1]]' style (also 【【1】】, ［［1］］)
 *   group 2: '[1]', '[1, 2]', '[1,2,16]' style (also unicode variants)
 */
const CITATION_PATTERN = /([[【［]{2}\d+[\]】］]{2})|([[【［]\d+(?:, ?\d+)*[\]】］])/g;

const CITATION_EXTRACT_PATTERN =
  /([[【［]{2}(\d+)[\]】］]{2})|([[【［](\d+(?: *, *\d+)*)[\]】］])/g;

export class DynamicCitationProcessor {
  /** Citation number -> SearchDoc mapping (dynamic, externally provided). */
  citationToDoc: CitationMapping = new Map();
  /** All citations seen while processing, regardless of mode. */
  seenCitations: CitationMapping = new Map();

  private llmOut = "";
  private readonly codeFenceTracker = new CodeFenceTracker();
  private currSegment = "";
  private hold = "";
  private readonly stopStream: string | null;
  private readonly citationMode: CitationMode;

  private citedDocumentsInOrder: SearchDoc[] = [];
  private readonly citedDocumentIds = new Set<string>();
  private readonly recentCitedDocuments = new Set<string>();
  private nonCitationCount = 0;
  private lastCitationEnd = -1;

  constructor(
    citationMode: CitationMode = "HYPERLINK",
    stopStream: string | null = process.env.STOP_STREAM_PAT ?? null,
  ) {
    this.citationMode = citationMode;
    this.stopStream = stopStream;
  }

  /** Merge a citation number -> SearchDoc mapping (citation_processor.py 347-378). */
  updateCitationMapping(mapping: CitationMapping, updateDuplicateKeys = false): void {
    for (const [num, doc] of mapping) {
      if (!updateDuplicateKeys && this.citationToDoc.has(num)) continue;
      this.citationToDoc.set(num, doc);
    }
  }

  /**
   * Process one LLM token; pass null at end of stream to flush. Yields display
   * text and (HYPERLINK mode) CitationInfoEvent entries.
   */
  *processToken(token: string | null): Generator<CitationStreamItem, void, unknown> {
    if (token === null) {
      this.codeFenceTracker.flush();
      yield* this.processSegment(true);
      return;
    }

    // Handle stop stream token (port of citation_processor.py 417-437)
    if (this.stopStream) {
      const nextHold = this.hold + token;
      const stopPos = nextHold.indexOf(this.stopStream);
      if (stopPos !== -1) {
        const textBeforeStop = nextHold.slice(0, stopPos);
        if (textBeforeStop) {
          this.hold = "";
          token = textBeforeStop;
        } else {
          return;
        }
      } else if (nextHold === this.stopStream.slice(0, nextHold.length)) {
        this.hold = nextHold;
        return;
      } else {
        token = nextHold;
        this.hold = "";
      }
    }

    this.currSegment += token;
    this.llmOut += token;
    this.codeFenceTracker.feed(token);
    yield* this.processSegment(false);
  }

  private *processSegment(final: boolean): Generator<CitationStreamItem, void, unknown> {
    const segmentOffset = this.llmOut.length - this.currSegment.length;
    const citationMatches: RegExpExecArray[] = [];
    let unsettled = false;
    CITATION_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CITATION_PATTERN.exec(this.currSegment)) !== null) {
      const offset = segmentOffset + match.index;
      if (this.codeFenceTracker.inCodeBlockAt(offset)) continue;
      if (!final && (this.codeFenceTracker.mayOpenAt(offset) || this.mayExtend(match))) {
        unsettled = true;
        break;
      }
      citationMatches.push(match);
    }
    const possibleCitationFound =
      unsettled ||
      (!final && POSSIBLE_CITATION_PATTERN.test(this.currSegment));

    let result = "";
    if (citationMatches.length > 0) {
      let matchIdx = 0;
      for (const citationMatch of citationMatches) {
        const matchSpan = [citationMatch.index, citationMatch.index + citationMatch[0].length];

        // Text before/between citations
        const intermatchStr = this.currSegment.slice(matchIdx, matchSpan[0]);
        this.nonCitationCount += intermatchStr.length;
        matchIdx = matchSpan[1];

        // A citation needs no added space after whitespace or right after
        // another citation, in this token or an earlier one.
        const start = segmentOffset + matchSpan[0];
        const hasLeadingSpace =
          start === this.lastCitationEnd ||
          (start > 0 && /\s/.test(this.llmOut[start - 1] ?? ""));
        this.lastCitationEnd = segmentOffset + matchSpan[1];

        // Reset recent citations if no citations found for a while
        if (this.nonCitationCount > 5) {
          this.recentCitedDocuments.clear();
        }

        const processed = this.processCitation(citationMatch, hasLeadingSpace);

        if (this.citationMode === "HYPERLINK") {
          if (intermatchStr) yield intermatchStr;
          for (const citation of processed.citationInfoList) {
            yield citation;
          }
          if (processed.formattedCitationText) {
            yield processed.formattedCitationText;
          }
        } else if (this.citationMode === "KEEP_MARKERS") {
          if (intermatchStr) yield intermatchStr;
          yield citationMatch[0];
        } else {
          // REMOVE: strip markers and fix up spacing to avoid double spaces.
          if (intermatchStr) {
            let cleaned = intermatchStr;
            const remainingText = this.currSegment.slice(matchSpan[1]);
            if (cleaned.length > 0 && /\s/.test(cleaned[cleaned.length - 1]) && remainingText) {
              const firstChar = remainingText[0];
              if (/\s/.test(firstChar) || ".,;:!?)]}".includes(firstChar)) {
                cleaned = cleaned.replace(/\s+$/, "");
              }
            }
            if (cleaned) yield cleaned;
          }
        }

        this.nonCitationCount = 0;
      }

      // Leftover text could be part of the next citation
      this.currSegment = this.currSegment.slice(matchIdx);
      this.nonCitationCount = this.currSegment.length;
    }

    // Hold onto the segment if potential citations are pending; else stream it.
    if (!possibleCitationFound) {
      result += this.currSegment;
      this.nonCitationCount += this.currSegment.length;
      this.currSegment = "";
    }

    if (result) yield result;
  }

  /** Whether `[n]` at the segment end could still become `[[n]]`. */
  private mayExtend(match: RegExpExecArray): boolean {
    const start = match.index;
    return (
      match[2] !== undefined &&
      match.index + match[0].length === this.currSegment.length &&
      start > 0 &&
      "[【［".includes(this.currSegment[start - 1] ?? "")
    );
  }

  /** Port of _process_citation (citation_processor.py lines 565-670). */
  private processCitation(
    match: RegExpExecArray,
    hasLeadingSpace: boolean,
  ): { formattedCitationText: string; citationInfoList: CitationInfoEvent[] } {
    const citationStr = match[0];
    const formatted = match[1] !== undefined; // '[[1]]' style

    const citationInfoList: CitationInfoEvent[] = [];
    const formattedCitationParts: string[] = [];

    const citationContent = formatted ? citationStr.slice(2, -2) : citationStr.slice(1, -1);

    for (const rawNum of citationContent.split(",")) {
      const numStr = rawNum.trim();
      if (!numStr) continue;
      const num = Number.parseInt(numStr, 10);
      if (Number.isNaN(num)) continue;

      const searchDoc = this.citationToDoc.get(num);
      if (!searchDoc) continue;

      const docId = searchDoc.document_id;
      const link = searchDoc.link ?? "";

      // Always track seen citations regardless of mode
      this.seenCitations.set(num, searchDoc);

      if (this.citationMode !== "HYPERLINK") continue;

      formattedCitationParts.push(`[[${num}]](${link})`);

      // Skip duplicate CitationInfo for recently cited documents
      if (this.recentCitedDocuments.has(docId)) continue;
      this.recentCitedDocuments.add(docId);

      if (!this.citedDocumentIds.has(docId)) {
        this.citedDocumentIds.add(docId);
        this.citedDocumentsInOrder.push(searchDoc);
        citationInfoList.push({ citation_number: num, document_id: docId });
      }
    }

    let formattedCitationText = formattedCitationParts.join(" ");
    if (formattedCitationText && !hasLeadingSpace) {
      formattedCitationText = ` ${formattedCitationText}`;
    }
    return { formattedCitationText, citationInfoList };
  }

  /** SearchDocs in the order they were first cited. */
  getCitedDocuments(): SearchDoc[] {
    return [...this.citedDocumentsInOrder];
  }

  getCitedDocumentIds(): string[] {
    return this.citedDocumentsInOrder.map((d) => d.document_id);
  }

  getSeenCitations(): CitationMapping {
    return this.seenCitations;
  }

  get numCitedDocuments(): number {
    return this.citedDocumentIds.size;
  }

  resetRecentCitations(): void {
    this.recentCitedDocuments.clear();
  }

  /** Next available citation number (citation_processor.py lines 754-777). */
  getNextCitationNumber(): number {
    if (this.citationToDoc.size === 0) return 1;
    return Math.max(...this.citationToDoc.keys()) + 1;
  }
}

// ============================================================================
// citation_utils.py ports
// ============================================================================

/**
 * Extract citation numbers from text in order of first appearance.
 * Port of extract_citation_order_from_text (citation_utils.py lines 70-111).
 */
export function extractCitationOrderFromText(text: string): number[] {
  const seen = new Set<number>();
  const order: number[] = [];
  CITATION_EXTRACT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CITATION_EXTRACT_PATTERN.exec(text)) !== null) {
    const numsStr = match[2] ?? match[4];
    if (!numsStr) continue;
    for (const rawNum of numsStr.split(",")) {
      const numStr = rawNum.trim();
      if (!numStr) continue;
      const num = Number.parseInt(numStr, 10);
      if (!Number.isNaN(num) && !seen.has(num)) {
        seen.add(num);
        order.push(num);
      }
    }
  }
  return order;
}

/**
 * Collapse citations in answer text to the smallest possible numbers,
 * reusing existing numbers for known documents.
 * Port of collapse_citations (citation_utils.py lines 114-231).
 */
export function collapseCitations(
  answerText: string,
  existingCitationMapping: CitationMapping,
  newCitationMapping: CitationMapping,
): { text: string; combinedMapping: CitationMapping } {
  const docIdToExistingCitation = new Map<string, number>();
  for (const [num, doc] of existingCitationMapping) {
    docIdToExistingCitation.set(doc.document_id, num);
  }

  let nextCitationNum =
    existingCitationMapping.size > 0
      ? Math.max(...existingCitationMapping.keys()) + 1
      : 1;

  const oldToNew = new Map<number, number>();
  const additionalMappings: CitationMapping = new Map();

  for (const [oldNum, searchDoc] of newCitationMapping) {
    const docId = searchDoc.document_id;
    if (docIdToExistingCitation.has(docId)) {
      oldToNew.set(oldNum, docIdToExistingCitation.get(docId) as number);
      continue;
    }
    // Same doc may appear under several old numbers: reuse the new number.
    let existingNewNum: number | null = null;
    for (const [mappedOld, mappedNew] of oldToNew) {
      const mappedDoc = newCitationMapping.get(mappedOld);
      if (mappedDoc && mappedDoc.document_id === docId) {
        existingNewNum = mappedNew;
        break;
      }
    }
    if (existingNewNum !== null) {
      oldToNew.set(oldNum, existingNewNum);
    } else {
      oldToNew.set(oldNum, nextCitationNum);
      additionalMappings.set(nextCitationNum, searchDoc);
      nextCitationNum += 1;
    }
  }

  const replacementPattern = /([[【［]{2}\d+[\]】］]{2})|([[【［]\d+(?:, ?\d+)*[\]】］])/g;
  const text = answerText.replace(replacementPattern, (citationStr) => {
    const isDouble = citationStr.startsWith("[[") || citationStr.startsWith("【【") || citationStr.startsWith("［［");
    const openBracket = isDouble ? citationStr.slice(0, 2) : citationStr[0];
    const closeBracket = isDouble ? citationStr.slice(-2) : citationStr[citationStr.length - 1];
    const content = isDouble ? citationStr.slice(2, -2) : citationStr.slice(1, -1);

    const newNums: string[] = [];
    for (const rawNum of content.split(",")) {
      const numStr = rawNum.trim();
      if (!numStr) continue;
      const num = Number.parseInt(numStr, 10);
      if (!Number.isNaN(num) && oldToNew.has(num)) {
        newNums.push(String(oldToNew.get(num)));
      } else {
        newNums.push(numStr);
      }
    }
    return `${openBracket}${newNums.join(", ")}${closeBracket}`;
  });

  const combinedMapping: CitationMapping = new Map(existingCitationMapping);
  for (const [num, doc] of additionalMappings) {
    combinedMapping.set(num, doc);
  }
  return { text, combinedMapping };
}

// ============================================================================
// Answer -> Citation[] (domain type) for DB persistence and the final packet
// ============================================================================

/**
 * Map the processor's seen citations onto the final answer: one Citation per
 * unique document, deduplicated by document_id and renumbered by first
 * appearance in the answer text (the order cited_documents_in_order +
 * CitationInfo emission produces in the Python implementation).
 */
export function buildCitationsForAnswer(
  answerText: string,
  seenCitations: CitationMapping,
): Citation[] {
  const citationOrder = extractCitationOrderFromText(answerText);
  const citations: Citation[] = [];
  const seenDocIds = new Set<string>();
  for (const num of citationOrder) {
    const doc = seenCitations.get(num);
    if (!doc || seenDocIds.has(doc.document_id)) continue;
    seenDocIds.add(doc.document_id);
    citations.push({
      citation_number: num,
      document_id: doc.document_id,
      semantic_identifier: doc.semantic_identifier,
      link: doc.link ?? null,
      blurb: doc.blurb,
      source_type: doc.source_type,
      chunk_id: doc.chunk_id,
      score: doc.score,
    });
  }
  return citations;
}
