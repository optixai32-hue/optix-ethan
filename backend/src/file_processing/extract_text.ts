/**
 * Text extraction — TypeScript port of
 * backend/onyx/file_processing/extract_file_text.py
 *   (extract_file_text_locally L811, read_pdf_file L240, read_text_file L195,
 *    detect_encoding L108, is_text_file L97)
 * backend/onyx/file_processing/html_utils.py
 *   (format_document_soup L90, parse_html_page_basic L175,
 *    strip_excessive_newlines_and_spaces L33)
 * backend/onyx/file_processing/pdfium_text.py (TEXT_SECTION_SEPARATOR = "\n\n")
 *
 * Dispatch table (extension -> parser), mirroring extension_to_function in
 * extract_file_text_locally:
 *   .txt/.md/.csv/.json (+ other plain text) -> native decode
 *   .html/.htm                               -> node-html-parser readable text
 *   .pdf                                     -> pure-TS PDF text extractor
 *     (parses PDF streams for BT..ET text operators; handles FlateDecode via
 *      node:zlib inflateSync; decodes literal/hex PDF strings incl. octal
 *      escapes and UTF-16BE; inserts newlines on the Td, TD, T-star and Tm
 *      operators; adds spaces on large negative TJ kerning). No external
 *      dependencies. Best effort: subset fonts with Identity-H CIDs without a
 *      parseable encoding yield no usable glyphs and the extractor throws a
 *      clear error.
 *   unknown                                  -> best-effort UTF-8 decode
 *
 * Sections are joined with "\n\n" like the Python TEXT_SECTION_SEPARATOR.
 */
import { inflateSync } from "node:zlib";
import { parse, type HTMLElement, type Node, type TextNode } from "node-html-parser";
import { getLogger } from "../utils/logger";

const logger = getLogger("file_processing.extract_text");

const SECTION_SEPARATOR = "\n\n"; // pdfium_text.py TEXT_SECTION_SEPARATOR

export function getFileExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx <= 0 || idx === filename.length - 1) return "";
  return filename.slice(idx).toLowerCase();
}

/**
 * Port of detect_encoding (L108): UTF-8 is self-validating — try it first,
 * then UTF-16 BOMs, then replacement chars.
 */
export function decodeBytes(content: Uint8Array): string {
  if (content.length === 0) return "";
  // UTF-8 BOM
  if (content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(content.subarray(3));
  }
  // UTF-16 BOMs
  if (content[0] === 0xfe && content[1] === 0xff) {
    return decodeUtf16be(content.subarray(2));
  }
  if (content[0] === 0xff && content[1] === 0xfe) {
    return Buffer.from(content.subarray(2)).toString("utf16le");
  }
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(content);
  return decoded;
}

function decodeUtf16be(bytes: Uint8Array): string {
  const swapped = Buffer.allocUnsafe(Math.floor(bytes.length / 2) * 2);
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    swapped[i] = bytes[i + 1];
    swapped[i + 1] = bytes[i];
  }
  return swapped.toString("utf16le");
}

/** Port of is_text_file (L97): first 1024 bytes printable/whitespace only? */
export function isTextFile(content: Uint8Array): boolean {
  const textChars = new Set<number>([7, 8, 9, 10, 12, 13, 27]);
  for (let b = 0x20; b <= 0xff; b++) {
    if (b !== 0x7f) textChars.add(b);
  }
  const sample = content.subarray(0, 1024);
  for (const byte of sample) {
    if (!textChars.has(byte)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// HTML (port of html_utils.py)
// ---------------------------------------------------------------------------

const HTML_SKIP_TAGS = new Set([
  "script", "style", "noscript", "template", "svg", "iframe", "head",
]);

function stripExcessiveNewlinesAndSpaces(text: string): string {
  return text
    .replace(/ {2,}/g, " ")
    .replace(/ +\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function isNodeElement(node: Node): node is HTMLElement {
  return node.nodeType === 1;
}

function isNodeText(node: Node): node is TextNode {
  return node.nodeType === 3;
}

function appendWithSpaceJoin(buffer: string, addition: string): string {
  if (
    buffer.length > 0 &&
    !/\s$/.test(buffer) &&
    addition.length > 0 &&
    !/^\s/.test(addition)
  ) {
    return buffer + " " + addition;
  }
  return buffer + addition;
}

interface HtmlWalkState {
  inTable: boolean;
}

/**
 * Recursive renderer equivalent to format_document_soup (L90): newlines around
 * block tags, "\n- " list items, tab/newline structure for tables, verbatim
 * <pre> content. Links are rendered as their text only (STRIP strategy).
 */
function renderHtmlNode(node: Node, state: HtmlWalkState): string {
  if (isNodeText(node)) {
    let text = node.rawText;
    if (state.inTable) {
      text = text.replace(/\s*\n\s*/g, " ").trim();
    }
    return text;
  }
  if (!isNodeElement(node)) return "";

  const tag = (node.rawTagName ?? "").toLowerCase();
  if (HTML_SKIP_TAGS.has(tag)) return "";
  if (tag === "br") return "\n";

  let out = "";
  if (tag === "table") {
    state.inTable = true;
    out += "\n" + renderChildren(node, state) + "\n";
    state.inTable = false;
    return out;
  }
  if (tag === "tr" && state.inTable) {
    return out + "\n" + renderChildren(node, state);
  }
  if ((tag === "td" || tag === "th") && state.inTable) {
    return out + renderChildren(node, state) + "\t";
  }
  if (state.inTable) {
    return out + renderChildren(node, state);
  }

  if (tag === "pre") {
    return "\n" + node.rawText + "\n";
  }

  if (tag === "li") {
    out += "\n- ";
  } else if (tag === "p" || tag === "div" || tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4") {
    out += "\n";
  }

  out += renderChildren(node, state);

  if (tag === "p" || tag === "div" || tag === "li" || tag.startsWith("h")) {
    out += "\n";
  }
  return out;
}

function renderChildren(node: HTMLElement, state: HtmlWalkState): string {
  let out = "";
  for (const child of node.childNodes) {
    const rendered = renderHtmlNode(child, state);
    if (rendered.length > 0) {
      out = appendWithSpaceJoin(out, rendered);
    }
  }
  return out;
}

/** Port of parse_html_page_basic (L175). */
export function parseHtmlToText(html: string): string {
  const root = parse(html);
  const state: HtmlWalkState = { inTable: false };
  return stripExcessiveNewlinesAndSpaces(renderHtmlNode(root, state));
}

// ---------------------------------------------------------------------------
// PDF (pure-TS extractor)
// ---------------------------------------------------------------------------

interface PdfStreamRecord {
  dict: string;
  data: Uint8Array;
}

/** Balanced "<<>>" dict immediately preceding a stream keyword. */
function extractDictBefore(s: string, kwStart: number): string {
  let i = kwStart - 1;
  // Skip whitespace between the dict close and the stream keyword.
  while (i >= 0 && /\s/.test(s[i])) i--;
  let end = -1; // position of the second '>' of the closing ">>"
  let depth = 0;
  while (i >= 1) {
    if (s[i] === ">" && s[i - 1] === ">") {
      if (depth === 0) end = i;
      depth += 1;
      i -= 2;
      continue;
    }
    if (s[i] === "<" && s[i - 1] === "<") {
      depth -= 1;
      if (depth === 0 && end !== -1) {
        // i is the second '<' of the opening "<<"; its first char is i-1.
        return s.slice(i - 1, end + 2);
      }
      i -= 2;
      continue;
    }
    i -= 1;
  }
  return "";
}

function findStreams(latin1: string): PdfStreamRecord[] {
  const streams: PdfStreamRecord[] = [];
  // Guard with [^d] so "endstream" itself never matches.
  const re = /(^|[^d])stream(\r\n|\n|\r)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(latin1)) !== null) {
    // kwStart = position of 's' in "stream" (works for both ^ and [^d] guards)
    const kwStart = match.index + match[1].length;
    const nl = match[2];
    const contentStart = kwStart + "stream".length + nl.length;
    const endIdx = latin1.indexOf("endstream", contentStart);
    if (endIdx === -1) continue;
    const dict = extractDictBefore(latin1, kwStart);
    // Trim trailing EOL before endstream
    let dataEnd = endIdx;
    while (dataEnd > contentStart && (latin1[dataEnd - 1] === "\r" || latin1[dataEnd - 1] === "\n")) {
      dataEnd--;
    }
    const latin1Buf = Buffer.from(latin1.slice(contentStart, dataEnd), "latin1");
    streams.push({ dict, data: new Uint8Array(latin1Buf) });
    re.lastIndex = endIdx + 9;
  }
  return streams;
}

function inflateStream(data: Uint8Array): Uint8Array | null {
  const buf = Buffer.from(data);
  try {
    return new Uint8Array(inflateSync(buf));
  } catch {
    return null;
  }
}

function dictHas(dict: string, token: string): boolean {
  return dict.includes(token);
}

/** /Filter values — either "/Name" or "[/A /B]" — in application order. */
function extractFilterChain(dict: string): string[] {
  const m = /\/Filter\s*(\/[A-Za-z0-9]+|\[[^\]]*\])/.exec(dict);
  if (!m) return [];
  return [...m[1].matchAll(/\/([A-Za-z0-9]+)/g)].map((t) => t[1]);
}

/** PDF Ascii85 (base-85) decode; input excludes the "<~" prefix, stops at "~>". */
function ascii85Decode(data: Buffer): Buffer | null {
  const out: number[] = [];
  let group: number[] = [];
  for (const byte of data) {
    const c = String.fromCharCode(byte);
    if (/\s/.test(c)) continue;
    if (c === "~") break;
    if (c === "z" && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < "!" || c > "u") return null;
    group.push(byte - 33);
    if (group.length === 5) {
      let n = 0;
      for (const g of group) n = n * 85 + g;
      out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
      group = [];
    }
  }
  if (group.length > 0) {
    const count = group.length - 1;
    while (group.length < 5) group.push(84); // pad with 'u'
    let n = 0;
    for (const g of group) n = n * 85 + g;
    const bytes = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    out.push(...bytes.slice(0, count));
  }
  return Buffer.from(out);
}

/** PDF ASCIIHexDecode: hex text up to ">". */
function asciiHexDecode(data: Buffer): Buffer | null {
  let hex = "";
  for (const byte of data) {
    const c = String.fromCharCode(byte);
    if (c === ">") break;
    if (/[0-9a-fA-F]/.test(c)) hex += c;
    else if (!/\s/.test(c)) return null;
  }
  if (hex.length % 2 === 1) hex += "0";
  const out = Buffer.allocUnsafe(hex.length / 2);
  for (let b = 0; b < out.length; b++) {
    out[b] = Number.parseInt(hex.slice(b * 2, b * 2 + 2), 16);
  }
  return out;
}

/**
 * Decode a stream body to content text, applying the /Filter chain in order
 * (FlateDecode, ASCII85Decode, ASCIIHexDecode). Returns null for image-only
 * or unsupported filters (best-effort skip, mirroring the Python extractor's
 * tolerance of unreadable streams).
 */
function decodeStreamBody(record: PdfStreamRecord): string | null {
  const filters = extractFilterChain(record.dict);
  let data: Buffer<ArrayBufferLike> = Buffer.from(record.data);
  if (filters.length === 0 && dictHas(record.dict, "/Image")) return null;
  for (const filter of filters) {
    if (filter === "FlateDecode") {
      try {
        data = inflateSync(data);
      } catch {
        return null;
      }
    } else if (filter === "ASCII85Decode") {
      const decoded = ascii85Decode(data);
      if (!decoded) return null;
      data = decoded;
    } else if (filter === "ASCIIHexDecode") {
      const decoded = asciiHexDecode(data);
      if (!decoded) return null;
      data = decoded;
    } else {
      // LZW / RunLength / DCT / JPX / CCITT — unsupported (best effort)
      return null;
    }
  }
  if (filters.length === 0 && dictHas(record.dict, "DCTDecode")) return null;
  return data.toString("latin1");
}

// ---- PDF object model (for ToUnicode CMap resolution) ----------------------

interface FontCMap {
  /** Bytes per character code (1 for simple fonts, 2 for Identity-H). */
  width: number;
  map: Map<number, string>;
}

/** objnum -> object body (everything between "N G obj" and "endobj"). */
function buildObjectMap(latin1: string): Map<number, string> {
  const map = new Map<number, string>();
  const re = /(?:^|[\s>])(\d+)\s+\d+\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(latin1)) !== null) {
    const num = Number.parseInt(m[1], 10);
    const bodyStart = m.index + m[0].length;
    const endIdx = latin1.indexOf("endobj", bodyStart);
    const body = latin1.slice(
      bodyStart,
      endIdx === -1 ? Math.min(bodyStart + 400_000, latin1.length) : endIdx,
    );
    map.set(num, body);
    re.lastIndex = endIdx === -1 ? latin1.length : endIdx + 6;
  }
  return map;
}

/**
 * Expand compressed object streams (/Type /ObjStm) into the object map —
 * modern PDFs store the page tree, fonts, and CMaps inside them.
 */
function expandObjectStreams(
  latin1: string,
  objectMap: Map<number, string>,
): void {
  for (const [, body] of [...objectMap]) {
    if (!/\/Type\s*\/ObjStm\b/.test(body)) continue;
    const nMatch = /\/N\s+(\d+)/.exec(body);
    const firstMatch = /\/First\s+(\d+)/.exec(body);
    if (!nMatch || !firstMatch) continue;
    const count = Number.parseInt(nMatch[1], 10);
    const firstOffset = Number.parseInt(firstMatch[1], 10);
    for (const record of findStreams(body)) {
      const inflated = decodeStreamBody(record);
      if (!inflated) continue;
      const header = inflated.slice(0, firstOffset);
      const pairs = header.split(/\s+/).filter(Boolean).map(Number);
      for (let k = 0; k < count && 2 * k + 1 < pairs.length; k++) {
        const objNum = pairs[2 * k];
        const relOffset = pairs[2 * k + 1];
        const objStart = firstOffset + relOffset;
        const objEnd =
          2 * (k + 1) + 1 < pairs.length
            ? firstOffset + pairs[2 * (k + 1) + 1]
            : inflated.length;
        if (objNum > 0 && objStart < objEnd) {
          objectMap.set(objNum, inflated.slice(objStart, objEnd));
        }
      }
    }
  }
}

/** /Key N 0 R (single or array form) -> referenced object numbers. */
function collectRefNums(body: string, key: string): number[] {
  const keyIdx = body.indexOf(`/${key}`);
  if (keyIdx === -1) return [];
  const nums: number[] = [];
  let i = keyIdx + key.length + 1;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    if (i >= body.length) break;
    if (body[i] === "[") { i++; continue; }
    if (body[i] === "]") break;
    if (body.startsWith("<<", i)) break;
    const m = /^(\d+)\s+\d+\s+R/.exec(body.slice(i));
    if (m) {
      nums.push(Number.parseInt(m[1], 10));
      i += m[0].length;
      continue;
    }
    break;
  }
  return nums;
}

/** Extract the inline "<<...>>" dict that follows /Key, if present. */
function extractInlineDictAfter(body: string, key: string): string | null {
  const keyIdx = body.indexOf(`/${key}`);
  if (keyIdx === -1) return null;
  let i = keyIdx + key.length + 1;
  while (i < body.length && /\s/.test(body[i])) i++;
  if (!body.startsWith("<<", i)) return null;
  let depth = 0;
  const start = i;
  while (i < body.length) {
    if (body.startsWith("<<", i)) { depth += 1; i += 2; continue; }
    if (body.startsWith(">>", i)) {
      depth -= 1;
      i += 2;
      if (depth === 0) return body.slice(start, i);
      continue;
    }
    i += 1;
  }
  return null;
}

/** Decode a hex UTF-16BE string from a CMap destination value. */
function decodeCmapHex(hex: string): string {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, "");
  const padded = clean.length % 2 === 1 ? `0${clean}` : clean;
  const bytes = new Uint8Array(padded.length / 2);
  for (let b = 0; b < bytes.length; b++) {
    bytes[b] = Number.parseInt(padded.slice(b * 2, b * 2 + 2), 16);
  }
  return decodeUtf16be(bytes);
}

/**
 * Parse a /ToUnicode CMap stream (bfchar + bfrange tables) into a code -> text
 * map; code width comes from the first key (default 1 byte).
 */
function parseToUnicodeCMap(cmapText: string): FontCMap {
  const map = new Map<number, string>();
  let width = 0;

  const bfcharRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let m: RegExpExecArray | null;
  while ((m = bfcharRe.exec(cmapText)) !== null) {
    const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let p: RegExpExecArray | null;
    while ((p = pairRe.exec(m[1])) !== null) {
      if (width === 0) width = p[1].length / 2;
      map.set(Number.parseInt(p[1], 16), decodeCmapHex(p[2]));
    }
  }

  const bfrangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfrangeRe.exec(cmapText)) !== null) {
    // <start> <end> [<dst1> <dst2> ...]
    const arrRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([^\]]*)\]/g;
    let p: RegExpExecArray | null;
    while ((p = arrRe.exec(m[1])) !== null) {
      if (width === 0) width = p[1].length / 2;
      const start = Number.parseInt(p[1], 16);
      const end = Number.parseInt(p[2], 16);
      const items = p[3].match(/<([0-9A-Fa-f]+)>/g) ?? [];
      for (let c = start, idx = 0; c <= end && idx < items.length; c++, idx++) {
        map.set(c, decodeCmapHex(items[idx].slice(1, -1)));
      }
    }
    // <start> <end> <dstStart> (incrementing range)
    const rangeRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    while ((p = rangeRe.exec(m[1])) !== null) {
      if (width === 0) width = p[1].length / 2;
      const start = Number.parseInt(p[1], 16);
      const end = Number.parseInt(p[2], 16);
      const dstBase = Number.parseInt(p[3], 16);
      for (let c = start; c <= end && c - start < 65_536; c++) {
        map.set(c, String.fromCodePoint(dstBase + (c - start)));
      }
    }
  }

  return { width: width > 0 ? width : 1, map };
}

/** Load the ToUnicode CMap of one font object (may be absent). */
function loadFontCMap(
  fontObjBody: string,
  objectMap: Map<number, string>,
): FontCMap | null {
  const toUnicodeRefs = collectRefNums(fontObjBody, "ToUnicode");
  for (const ref of toUnicodeRefs) {
    const cmapObjBody = objectMap.get(ref);
    if (!cmapObjBody) continue;
    for (const record of findStreams(cmapObjBody)) {
      const content = decodeStreamBody(record);
      if (!content) continue;
      const parsed = parseToUnicodeCMap(content);
      if (parsed.map.size > 0) return parsed;
    }
  }
  return null;
}

/** /Font << /F1 5 0 R ... >> (or ref) -> font name -> parsed CMap. */
function loadPageFontCMaps(
  resourcesBody: string,
  objectMap: Map<number, string>,
): Map<string, FontCMap> {
  const fonts = new Map<string, FontCMap>();
  const fontRefs = collectRefNums(resourcesBody, "Font");
  const fontDict =
    fontRefs.length > 0
      ? objectMap.get(fontRefs[0])
      : extractInlineDictAfter(resourcesBody, "Font");
  if (!fontDict) return fonts;
  const entryRe = /\/([A-Za-z0-9_.+-]+)\s+(\d+)\s+\d+\s+R/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(fontDict)) !== null) {
    const name = m[1];
    const fontObjNum = Number.parseInt(m[2], 10);
    if (fonts.has(name)) continue;
    const fontObjBody = objectMap.get(fontObjNum);
    if (!fontObjBody) continue;
    const cmap = loadFontCMap(fontObjBody, objectMap);
    if (cmap) fonts.set(name, cmap);
  }
  return fonts;
}

interface PageContent {
  contentNums: number[];
  resourcesBody: string | null;
}

/**
 * Walk the page tree: every object with /Type /Page, resolving /Contents refs
 * and /Resources (inline, referenced, or inherited through /Parent chains).
 */
function collectPages(objectMap: Map<number, string>): PageContent[] {
  const pages: PageContent[] = [];
  for (const [num, body] of objectMap) {
    if (!/\/Type\s*\/Page\b/.test(body) || /\/Type\s*\/Pages\b/.test(body)) continue;
    const contentNums = collectRefNums(body, "Contents");
    let resourcesBody = extractInlineDictAfter(body, "Resources");
    if (!resourcesBody) {
      const resourcesRef = collectRefNums(body, "Resources");
      if (resourcesRef.length > 0) {
        resourcesBody = objectMap.get(resourcesRef[0]) ?? null;
      }
    }
    // Inherit Resources from ancestor Pages objects when absent.
    let cursor = num;
    let hops = 0;
    while (!resourcesBody && hops < 12) {
      hops += 1;
      const parentRefs = collectRefNums(objectMap.get(cursor) ?? "", "Parent");
      if (parentRefs.length === 0) break;
      cursor = parentRefs[0];
      const parentBody = objectMap.get(cursor);
      if (!parentBody) break;
      resourcesBody = extractInlineDictAfter(parentBody, "Resources");
      if (!resourcesBody) {
        const resourcesRef = collectRefNums(parentBody, "Resources");
        if (resourcesRef.length > 0) {
          resourcesBody = objectMap.get(resourcesRef[0]) ?? null;
        }
      }
    }
    pages.push({ contentNums, resourcesBody });
  }
  return pages;
}

/** PDF literal string reader: returns the raw bytes after escape resolution. */
function readLiteralString(s: string, start: number): { bytes: Uint8Array; end: number } | null {
  const bytes: number[] = [];
  let i = start + 1; // skip '('
  let depth = 1;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      const next = s[i + 1];
      if (next === undefined) break;
      if (next === "n") { bytes.push(10); i += 2; continue; }
      if (next === "r") { bytes.push(13); i += 2; continue; }
      if (next === "t") { bytes.push(9); i += 2; continue; }
      if (next === "b") { bytes.push(8); i += 2; continue; }
      if (next === "f") { bytes.push(12); i += 2; continue; }
      if (next === "(") { bytes.push(40); i += 2; continue; }
      if (next === ")") { bytes.push(41); i += 2; continue; }
      if (next === "\\") { bytes.push(92); i += 2; continue; }
      const octal = /^[0-7]{1,3}/.exec(s.slice(i + 1));
      if (octal) {
        bytes.push(Number.parseInt(octal[0], 8));
        i += 1 + octal[0].length;
        continue;
      }
      // backslash-newline line continuation emits nothing
      if (next === "\n") { i += 2; continue; }
      if (next === "\r") {
        i += s[i + 2] === "\n" ? 3 : 2;
        continue;
      }
      bytes.push(next.charCodeAt(0) & 0xff);
      i += 2;
      continue;
    }
    if (c === "(") { depth += 1; bytes.push(40); i += 1; continue; }
    if (c === ")") {
      depth -= 1;
      if (depth === 0) return { bytes: new Uint8Array(bytes), end: i + 1 };
      bytes.push(41);
      i += 1;
      continue;
    }
    bytes.push(c.charCodeAt(0) & 0xff);
    i += 1;
  }
  return null;
}

function readHexString(s: string, start: number): { bytes: Uint8Array; end: number } | null {
  let i = start + 1; // skip '<'
  let hex = "";
  while (i < s.length) {
    const c = s[i];
    if (c === ">") break;
    if (/[0-9a-fA-F]/.test(c)) hex += c;
    else if (!/\s/.test(c)) return null;
    i += 1;
  }
  if (i >= s.length) return null;
  if (hex.length % 2 === 1) hex += "0";
  const bytes = new Uint8Array(hex.length / 2);
  for (let b = 0; b < bytes.length; b++) {
    bytes[b] = Number.parseInt(hex.slice(b * 2, b * 2 + 2), 16);
  }
  return { bytes, end: i + 1 };
}

function printableRatio(text: string): number {
  if (text.length === 0) return 0;
  let printable = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 || code === 9 || code === 10 || code === 13) printable++;
  }
  return printable / text.length;
}

function isPrintableish(text: string): boolean {
  return printableRatio(text) >= 0.85;
}

/** Decode PDF string bytes: UTF-16BE marker, heuristic UTF-16, else latin1. */
function decodePdfStringBytes(raw: Uint8Array): string {
  if (raw.length === 0) return "";
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
    return decodeUtf16be(raw.subarray(2));
  }
  let hasControl = false;
  for (const b of raw) {
    if (b < 0x20 && b !== 9 && b !== 10 && b !== 13) { hasControl = true; break; }
  }
  if (raw.length % 2 === 0 && (raw[0] === 0x00 || hasControl)) {
    const asUtf16 = decodeUtf16be(raw);
    if (isPrintableish(asUtf16)) return asUtf16;
  }
  return Buffer.from(raw).toString("latin1");
}

/**
 * Font-aware string decode: split raw bytes into code-width units and map
 * through the font's ToUnicode CMap; missing mappings fall back to the direct
 * byte decode when it looks sane.
 */
function decodePdfString(raw: Uint8Array, cmap: FontCMap | null): string {
  if (!cmap || raw.length === 0) return decodePdfStringBytes(raw);
  const w = cmap.width;
  let out = "";
  for (let i = 0; i + w <= raw.length; i += w) {
    let code = 0;
    for (let b = 0; b < w; b++) code = (code << 8) | raw[i + b];
    const mapped = cmap.map.get(code);
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const direct =
      w === 2 && raw[i] === 0
        ? String.fromCharCode(raw[i + 1])
        : decodePdfStringBytes(raw.subarray(i, i + w));
    if (direct.length === 1 && isPrintableish(direct)) {
      out += direct;
    }
  }
  return out;
}

/** Extract text from one decoded content stream (BT..ET text operators). */
function extractTextFromContentStream(
  content: string,
  fonts: Map<string, FontCMap>,
): string {
  const out: string[] = [];
  const pending: Uint8Array[] = [];
  let currentFont: FontCMap | null = null;
  let lastFontName: string | null = null;
  // Numeric operand ring (last 8 numbers since the previous operator) — used
  // by positioning operators to decide whether the text line moved vertically.
  const numStack: number[] = [];
  let lastTextY: number | null = null;
  let i = 0;
  const n = content.length;

  const flushPending = (): string => {
    if (pending.length === 0) return "";
    const text = pending.map((raw) => decodePdfString(raw, currentFont)).join("");
    pending.length = 0;
    return text;
  };

  while (i < n) {
    const c = content[i];
    if (c === "(") {
      const str = readLiteralString(content, i);
      if (str) { pending.push(str.bytes); i = str.end; continue; }
      i += 1;
      continue;
    }
    if (c === "<" && content[i + 1] === "<") {
      // inline dict (e.g. BDC properties) — skip balanced
      let depth = 0;
      while (i < n) {
        if (content.startsWith("<<", i)) { depth += 1; i += 2; continue; }
        if (content.startsWith(">>", i)) {
          depth -= 1;
          i += 2;
          if (depth === 0) break;
          continue;
        }
        i += 1;
      }
      continue;
    }
    if (c === "<") {
      const str = readHexString(content, i);
      if (str) { pending.push(str.bytes); i = str.end; continue; }
      i += 1;
      continue;
    }
    if (c === "/") {
      i += 1;
      const nameStart = i;
      while (i < n && !/[\s/()[\]<>{}%]/.test(content[i])) i += 1;
      lastFontName = content.slice(nameStart, i);
      continue;
    }
    if (c === "[" || c === "]") { i += 1; continue; }
    if (c === "%") {
      while (i < n && content[i] !== "\n" && content[i] !== "\r") i += 1;
      continue;
    }
    if (/\s/.test(c)) { i += 1; continue; }
    if (/[0-9.+-]/.test(c)) {
      const num = /^-?[\d.]+(?:e[-+]?\d+)?/i.exec(content.slice(i));
      if (num) {
        const value = Number.parseFloat(num[0]);
        if (Number.isFinite(value)) {
          // Large negative TJ kerning implies a word space.
          if (value < -250 && pending.length > 0) {
            pending.push(new Uint8Array([32]));
          }
          numStack.push(value);
          if (numStack.length > 8) numStack.shift();
        }
        i += num[0].length;
        continue;
      }
      i += 1;
      continue;
    }

    // operator / other keyword word
    const word = /^[A-Za-z'"*]+/.exec(content.slice(i));
    const op = word ? word[0] : c;
    i += op.length;

    if (op === "Tf") {
      currentFont = lastFontName ? (fonts.get(lastFontName) ?? currentFont) : currentFont;
    } else if (op === "Tj" || op === "TJ") {
      out.push(flushPending());
    } else if (op === "'" || op === '"') {
      out.push("\n" + flushPending());
    } else if (op === "Td" || op === "TD") {
      // operands: tx ty — only a vertical move breaks the line
      const ty = numStack.length >= 2 ? numStack[numStack.length - 1] : null;
      if (ty !== null && ty !== 0) {
        out.push("\n");
        if (lastTextY !== null) lastTextY += ty;
      }
    } else if (op === "T*") {
      out.push("\n");
    } else if (op === "Tm") {
      // operands: a b c d e f — compare absolute y (f)
      const y = numStack.length >= 6 ? numStack[numStack.length - 1] : null;
      if (y !== null && (lastTextY === null || Math.abs(y - lastTextY) > 0.01)) {
        out.push("\n");
      }
      if (y !== null) lastTextY = y;
    } else if (op === "BI") {
      // skip inline image until EI
      const ei = content.indexOf("EI", i);
      i = ei === -1 ? n : ei + 2;
    }
    numStack.length = 0; // operators consume their numeric operands
    // BT/ET/Tc/Tw/etc — no output
  }
  return out.join("");
}

/** Collapse the raw operator output into readable lines. */
function normalizeExtracted(raw: string): string {
  return raw
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/\u0000/g, "")
    .trim();
}

/**
 * Pure-TS PDF text extraction (best-effort port of read_pdf_file L240 /
 * extract_pdf_text_pdfium). The page tree is walked so each page's content
 * streams are decoded with their fonts' ToUnicode CMaps (handling subset /
 * Identity-H fonts); page texts join with TEXT_SECTION_SEPARATOR like the
 * Python page join. Falls back to a global stream sweep when the page tree is
 * unresolvable. Throws a clear error when nothing usable is found.
 */
export function extractPdfText(content: Uint8Array, filename: string): string {
  const latin1 = Buffer.from(content).toString("latin1");
  const objectMap = buildObjectMap(latin1);
  expandObjectStreams(latin1, objectMap);
  const pageTexts: string[] = [];

  const pages = collectPages(objectMap);
  if (pages.length > 0) {
    for (const page of pages) {
      const fonts = page.resourcesBody
        ? loadPageFontCMaps(page.resourcesBody, objectMap)
        : new Map<string, FontCMap>();
      const pageParts: string[] = [];
      for (const contentNum of page.contentNums) {
        const objBody = objectMap.get(contentNum);
        if (!objBody) continue;
        for (const record of findStreams(objBody)) {
          const decoded = decodeStreamBody(record);
          if (!decoded || !/BT|Tj|TJ|Td|Tm/.test(decoded)) continue;
          const raw = extractTextFromContentStream(decoded, fonts);
          const normalized = normalizeExtracted(raw);
          if (normalized.length > 0) pageParts.push(normalized);
        }
      }
      if (pageParts.length > 0) pageTexts.push(pageParts.join("\n"));
    }
  }

  // Fallback: sweep every stream (covers damaged page trees / XFA-lite docs).
  if (pageTexts.length === 0) {
    const allCMaps: FontCMap[] = [];
    for (const body of objectMap.values()) {
      if (!/\/Type\s*\/Font\b/.test(body)) continue;
      const cmap = loadFontCMap(body, objectMap);
      if (cmap) allCMaps.push(cmap);
    }
    // A single file-wide CMap is unambiguous enough to use everywhere.
    const anyCMap = allCMaps.length === 1 ? allCMaps[0] : null;
    for (const record of findStreams(latin1)) {
      const isImage =
        dictHas(record.dict, "/Image") ||
        dictHas(record.dict, "DCTDecode") ||
        dictHas(record.dict, "JPXDecode");
      if (isImage) continue;
      const decoded = decodeStreamBody(record);
      if (!decoded || !/BT|Tj|TJ|Td|Tm/.test(decoded)) continue;
      const raw = extractTextFromContentStream(
        decoded,
        anyCMap ? new Map([["", anyCMap]]) : new Map(),
      );
      const normalized = normalizeExtracted(raw);
      if (normalized.length > 0) pageTexts.push(normalized);
    }
  }

  const joined = pageTexts.join(SECTION_SEPARATOR);
  if (joined.trim().length === 0) {
    throw new Error(
      `Failed to extract text from PDF "${filename}": no extractable text (scanned/image-only PDF or unsupported font encoding)`,
    );
  }
  return joined;
}

// ---------------------------------------------------------------------------
// Dispatch (port of extract_file_text_locally L811)
// ---------------------------------------------------------------------------

const NATIVE_TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".json", ".text", ".log", ".yaml",
  ".yml", ".rst", ".tsv", ".xml", ".pem", ".conf", ".ini",
]);

const HTML_EXTENSIONS = new Set([".html", ".htm", ".xhtml"]);

export type FileContent = string | Uint8Array;

function toBytes(content: FileContent): Uint8Array {
  if (typeof content === "string") {
    return new Uint8Array(Buffer.from(content, "utf8"));
  }
  return content;
}

function toText(content: FileContent): string {
  return typeof content === "string" ? content : decodeBytes(content);
}

/**
 * Port of extract_file_text (L778) / extract_file_text_locally (L811).
 * Returns the extracted text; sections joined by "\n\n". Throws for PDFs it
 * cannot read (mirroring break_on_unprocessable=true). Binary formats (PDF)
 * should be passed as Uint8Array; string input is interpreted as UTF-8 text.
 */
export function extractFileText(filename: string, content: FileContent): string {
  const ext = getFileExtension(filename);
  logger.debug("extracting file text", { filename, ext });

  if (ext === ".pdf") {
    return extractPdfText(toBytes(content), filename);
  }
  if (HTML_EXTENSIONS.has(ext)) {
    return parseHtmlToText(toText(content));
  }
  if (NATIVE_TEXT_EXTENSIONS.has(ext)) {
    return toText(content);
  }
  // Unknown extension — best-effort UTF-8 decode (mirrors the
  // is_text_file fallback in extract_file_text_locally, always decode).
  return toText(content);
}
