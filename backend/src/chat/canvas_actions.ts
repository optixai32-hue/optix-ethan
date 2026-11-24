/**
 * Canvas actions — the Deep Search canvas panel toolbar (the reference
 * video's split-view tools: Ajouter la touche finale / Format / Longueur /
 * Tonalité / Public / Traduire).
 *
 * A toolbar action submits its pill message into the chat (the frontend
 * prefixes it with "[canvas] "). When the session has a canvas artifact the
 * message routes here instead of the normal agent loop:
 *
 *   1. a brief Thinking step (the bot "réfléchit")
 *   2. a NEW canvas timeline step — the updated document streams LIVE into
 *      the step (and the open split-view panel): every provider delta is
 *      emitted the moment it arrives, exactly like the Deep Search canvas
 *      phase (deep_research.ts runCanvasPhase)
 *   3. the artifact row is updated (the canvas persists with the session)
 *   4. a brief answer streams in the chat (the bot "répond")
 *
 * Truncation safety (the upstream content filter cuts some generations
 * mid-flight, `finish_reason: "sensitive"`): a cut attempt is NOT left on
 * screen — the canvas RESTARTS on the next timeline turn (a fresh
 * `research_agent_start` group; the frontend hides the superseded attempt),
 * the validated prefix is resent, and the failing chunk is regenerated (then,
 * if still cut, written in its original text). The turn counter is therefore
 * dynamic: `answerTurn` tells the caller where the chat answer goes.
 *
 * Translate actions use the translation prompt (markdown structure
 * preserved exactly); every other action is a refinement of the document.
 */
import type { LLMProvider, LLMMessage } from "../llm/types";
import type { StreamEmitter } from "./emitter";
import { getLogger } from "../utils/logger";

const logger = getLogger("chat.canvas_actions");

/** Frontend marker: the canvas pill messages carry this prefix. */
export const CANVAS_ACTION_PREFIX = "[canvas] ";

/** Parse the canvas pill marker; null when the message is not one. */
export function parseCanvasAction(message: string): string | null {
  if (!message.startsWith(CANVAS_ACTION_PREFIX)) return null;
  const instruction = message.slice(CANVAS_ACTION_PREFIX.length).trim();
  return instruction || null;
}

/** French language names (and their variants) → canonical English names. */
const LANG_FR_TO_EN: Record<string, string> = {
  chinois: "Chinese",
  chinoise: "Chinese",
  "le chinois": "Chinese",
  anglais: "English",
  anglaise: "English",
  "l'anglais": "English",
  "l’anglais": "English",
  français: "French",
  francais: "French",
  "le français": "French",
  "le francais": "French",
  allemand: "German",
  allemande: "German",
  "l'allemand": "German",
  "l’allemand": "German",
  grec: "Greek",
  grecque: "Greek",
  "le grec": "Greek",
  russe: "Russian",
  "le russe": "Russian",
  espagnol: "Spanish",
  espagnole: "Spanish",
  "l'espagnol": "Spanish",
  "l’espagnol": "Spanish",
};

/**
 * Match a translate instruction ("Traduire le texte en anglais" /
 * "Translate the text into English") and return the canonical target
 * language, or null when the instruction is not a translation.
 */
export function matchTranslateInstruction(instruction: string): string | null {
  const fr = /^traduire le texte en\s+(.+?)\s*\.?$/i.exec(instruction.trim());
  if (fr) {
    const name = fr[1]!.trim().toLowerCase();
    return LANG_FR_TO_EN[name] ?? name.replace(/^\w/, (c) => c.toUpperCase());
  }
  const en = /^translate the text (?:in)?to\s+(.+?)\s*\.?$/i.exec(
    instruction.trim(),
  );
  if (en) {
    return en[1]!.trim();
  }
  return null;
}

/** The translation system prompt (mirrors the artifacts/translate route). */
const TRANSLATE_SYSTEM_PROMPT = [
  "You are a professional document translator.",
  "Translate the provided markdown document into the target language.",
  "Preserve the markdown structure EXACTLY: heading levels, numbered and bulleted lists, bold and italic markers, tables (same columns and rows order), links (translate their visible text but keep the URLs unchanged), and citation markers like [1], [2] as-is.",
  "Translate naturally for a native reader of the target language; keep proper nouns, brand names, and model/product names in their usual form.",
  "Output ONLY the translated markdown document — no commentary, no fences, no explanation before or after.",
].join("\n");

/** The refinement system prompt for every non-translate toolbar action. */
const REFINE_SYSTEM_PROMPT = [
  "You are refining an existing research canvas document at the user's request.",
  "Apply the requested change to the document while preserving its identity: keep the language of the document (unless asked to translate), the heading structure, the tables, the numbered citation markers like [1], [2] EXACTLY as they are, and the factual content — only the requested property changes.",
  "Output ONLY the full updated markdown document — no commentary, no fences, no explanation before or after.",
].join("\n");

/** Canonical English language name → French (for the French answer lines). */
const LANG_EN_TO_FR: Record<string, string> = {
  Chinese: "chinois",
  English: "anglais",
  French: "français",
  German: "allemand",
  Greek: "grec",
  Russian: "russe",
  Spanish: "espagnol",
};

/** CJK targets translate to a much denser script (fewer chars than input). */
function isCjkTarget(language: string): boolean {
  return /chinese|japanese|korean|mandarin|cantonese/i.test(language);
}

/**
 * Split a markdown document into top-level sections: the H1 preamble (title
 * + prepared-date block) then every "## " heading block. The split keeps the
 * heading line with its body so each section translates standalone. Returns
 * the sections and the separator text between them (preserved on rebuild).
 */
export function splitMarkdownSections(markdown: string): string[] {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const sections = normalized.split(/\n(?=#{2,3} )/g);
  return sections.filter((s) => s.trim().length > 0);
}

/** True when a translated chunk is suspiciously short for its input. */
function translationLooksTruncated(
  input: string,
  output: string,
  cjkTarget: boolean,
): boolean {
  const ratio = output.trim().length / Math.max(input.trim().length, 1);
  return ratio < (cjkTarget ? 0.15 : 0.45);
}

/**
 * Emit finalized text into the canvas step as small deltas — used for
 * wholesale writes (the restart resend of the validated prefix, and fallback
 * originals): line-boundary chunks keep markdown intact and visibly write.
 */
function emitChunked(emitter: StreamEmitter, turn: number, text: string): void {
  if (!text) return;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    emitter.send("intermediate_report_delta", turn, i === 0 ? lines[i] : `\n${lines[i]}`);
  }
}

/**
 * CanvasStream — the live canvas step writer.
 *
 * Owns the canvas turn counter. `write` emits every delta the MOMENT it
 * arrives (the visible progressive writing). When a generation is cut
 * (`finish_reason: sensitive` / suspiciously short), `restart()` bumps the
 * turn, reopens a fresh canvas group and resends the validated prefix — the
 * superseded attempt (its own timeline turn) is hidden by the frontend, so
 * the user only ever sees complete-looking attempts that grow monotonically.
 */
class CanvasStream {
  /** Validated text — survives restarts (resent on the new turn). */
  private committed = "";
  private _turn: number;

  constructor(
    private readonly emitter: StreamEmitter,
    startTurn: number,
    private readonly title: string,
  ) {
    this._turn = startTurn;
  }

  /** The CURRENT canvas turn (bumps on restart). */
  get turn(): number {
    return this._turn;
  }

  /** The validated document so far (what a restart resends). */
  get text(): string {
    return this.committed;
  }

  /** Open the canvas group on the current turn (start packets). */
  open(): void {
    this.emitter.sendObject("research_agent_start", this._turn, {
      research_task: `Canvas : ${this.title}`,
    });
    this.emitter.sendObject("intermediate_report_start", this._turn, {});
  }

  /** Live delta — emitted the moment it arrives (progressive writing). */
  write(delta: string): void {
    if (!delta) return;
    this.emitter.send("intermediate_report_delta", this._turn, delta);
  }

  /** Wholesale write of finalized text (fallback originals, separators). */
  writeFinal(text: string): void {
    if (!text) return;
    emitChunked(this.emitter, this._turn, text);
  }

  /** Validate-and-keep: `text` is now part of the committed document. */
  keep(text: string): void {
    this.committed += text;
  }

  /**
   * Abandon the current attempt: new turn, fresh canvas group, the
   * validated prefix resent so the new attempt starts complete.
   */
  restart(): void {
    this._turn += 1;
    this.open();
    emitChunked(this.emitter, this._turn, this.committed);
  }
}

/**
 * Generate one chunk through the provider, streaming every delta LIVE into
 * the canvas (`stream.write`) the moment it arrives. Returns the full text
 * and whether the generation ended cleanly (`finish_reason: stop` — a
 * content-filter cut reports `clean: false`, never emitting more of the
 * aborted text afterwards: the caller restarts).
 */
async function streamChunkLive(
  provider: LLMProvider,
  messages: LLMMessage[],
  stream: CanvasStream,
  opts: {
    signal?: AbortSignal;
    maxTokens: number;
  },
): Promise<{ text: string; clean: boolean }> {
  let text = "";
  let clean = true;
  try {
    for await (const event of provider.stream(messages, {
      signal: opts.signal,
      maxTokens: opts.maxTokens,
    })) {
      if (event.delta) {
        text += event.delta;
        stream.write(event.delta);
      }
      if (
        event.finish_reason &&
        event.finish_reason !== "stop" &&
        event.finish_reason !== "tool_calls"
      ) {
        // "sensitive" / "length" / … — the upstream cut the generation.
        clean = false;
      }
      if (event.done || event.finish_reason === "stop") break;
    }
  } catch (err) {
    logger.warning("canvas action chunk generation failed", {
      error: String(err),
    });
    return { text, clean: false };
  }
  return { text, clean };
}

/** The reasoning line shown in the Thinking step (action-localized). */
function reasoningLine(instruction: string, language: string | null): string {
  const isFrench = /traduire|ajouter|formater|raccourcir|développer|ajuster|adapter/i.test(
    instruction,
  );
  if (language) {
    const frName = LANG_EN_TO_FR[language] ?? language.toLowerCase();
    return isFrench
      ? `Mise à jour du canvas : traduction du document en ${frName}.`
      : `Updating the canvas: translating the document into ${language}.`;
  }
  return isFrench
    ? `Mise à jour du canvas : ${instruction}`
    : `Updating the canvas: ${instruction}`;
}

/** The brief chat answer once the document is updated. */
function answerText(
  instruction: string,
  language: string | null,
  untranslatedSections = 0,
): string {
  const isFrench = /traduire|ajouter|formater|raccourcir|développer|ajuster|adapter/i.test(
    instruction,
  );
  // Some sections kept their original language (upstream content filter cut
  // their translation twice) — say so, honestly and briefly.
  const note =
    untranslatedSections > 0
      ? isFrench
        ? " (quelques sections ont été conservées dans leur langue d'origine)"
        : " (a few sections were kept in their original language)"
      : "";
  if (language) {
    const frName = LANG_EN_TO_FR[language] ?? language.toLowerCase();
    return isFrench
      ? `J'ai traduit le document en ${frName}. Le canvas mis à jour s'affiche dans le panneau.${note}`
      : `I translated the document into ${language}. The updated canvas is shown in the panel.${note}`;
  }
  return isFrench
    ? `J'ai mis à jour le document — ${instruction.replace(/\.$/, "")}. Le canvas mis à jour s'affiche dans le panneau.${note}`
    : `I updated the document — ${instruction.replace(/\.$/, "")}. The updated canvas is shown in the panel.${note}`;
}

export interface CanvasActionResult {
  /** The updated canvas document (already streamed to the user). */
  updatedContent: string;
  /** The brief chat answer to stream after the canvas step. */
  answerText: string;
  /** Sections that kept their original text (upstream content filter). */
  untranslatedSections: number;
  /**
   * Timeline turn the caller streams the answer on — after the canvas's
   * FINAL turn (restarts bump the canvas turn, so this is dynamic).
   */
  answerTurn: number;
}

/**
 * Translate the artifact section by section, LIVE: each section's deltas
 * stream the moment they arrive. The upstream content filter truncates some
 * whole-document CJK translations mid-flight (`finish_reason: "sensitive"`);
 * each section is translated on its own and integrity-checked (a CJK target
 * naturally compresses to ~30% of the source's characters). A cut section
 * RESTARTS the canvas on the next turn (validated prefix resent, superseded
 * attempt hidden by the frontend) and is retried once; when the filter
 * still cuts it, the section is kept in the document's original language —
 * also on a fresh turn — so the canvas NEVER ends up truncated.
 */
async function translateDocumentSectioned(opts: {
  provider: LLMProvider;
  stream: CanvasStream;
  artifact: { title: string; content: string };
  translateLanguage: string;
  signal?: AbortSignal;
}): Promise<{ content: string; untranslated: number }> {
  const { provider, stream, artifact, translateLanguage, signal } = opts;
  const cjkTarget = isCjkTarget(translateLanguage);
  const sections = splitMarkdownSections(artifact.content);
  const out: string[] = [];
  let untranslated = 0;

  for (const section of sections) {
    const messages: LLMMessage[] = [
      { role: "system", content: TRANSLATE_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Target language: ${translateLanguage}\n\nDocument to translate (translate this section on its own, keeping its headings):\n\n${section}`,
      },
    ];

    // Attempt 1 — the section streams live into the current canvas turn.
    let best = await streamChunkLive(provider, messages, stream, {
      signal,
      maxTokens: 8000,
    });
    if (best.clean && !translationLooksTruncated(section, best.text, cjkTarget)) {
      const accepted = best.text.trimEnd();
      stream.write("\n\n");
      stream.keep(accepted + "\n\n");
      out.push(accepted);
      continue;
    }

    // Cut mid-section — restart on a fresh turn (prefix resent, aborted
    // attempt hidden) and retry the section once.
    logger.warning("canvas translation section truncated; restarting turn", {
      section: section.slice(0, 60),
      finish_clean: best.clean,
    });
    stream.restart();
    best = await streamChunkLive(provider, messages, stream, {
      signal,
      maxTokens: 8000,
    });
    if (best.clean && !translationLooksTruncated(section, best.text, cjkTarget)) {
      const accepted = best.text.trimEnd();
      stream.write("\n\n");
      stream.keep(accepted + "\n\n");
      out.push(accepted);
      continue;
    }

    // The filter cut this section twice — keep the original text (a fresh
    // turn again): a complete document with one section in its original
    // language beats a truncated translation.
    logger.warning("canvas translation section cut twice; keeping original", {
      section: section.slice(0, 60),
    });
    stream.restart();
    stream.writeFinal(section);
    stream.write("\n\n");
    stream.keep(section + "\n\n");
    out.push(section);
    untranslated += 1;
  }

  return { content: stream.text.trimEnd(), untranslated };
}

/**
 * Run a canvas toolbar action: stream the updated document as a REAL canvas
 * timeline step (research_agent_start "Canvas : {title}" group, exactly like
 * the Deep Search canvas phase) and return the texts the caller persists.
 *
 * Packet timeline (turns): reasoning on `startTurn`; the canvas step(s) on
 * `startTurn + 1` (one MORE turn per content-filter restart); the caller
 * streams the answer on `answerTurn` (after the canvas's final turn).
 */
export async function runCanvasAction(opts: {
  provider: LLMProvider;
  emitter: StreamEmitter;
  /** The pill instruction (marker already stripped). */
  instruction: string;
  /** Canonical target language when the action is a translation. */
  translateLanguage: string | null;
  /** The session's current canvas artifact (title + content). */
  artifact: { title: string; content: string };
  /** Timeline turn the Thinking step occupies. */
  startTurn: number;
  signal?: AbortSignal;
}): Promise<CanvasActionResult> {
  const { provider, emitter, instruction, translateLanguage, artifact, startTurn } =
    opts;

  // ---- 1. Brief Thinking step (the video: the bot "réfléchit" first).
  const reasoning = reasoningLine(instruction, translateLanguage);
  emitter.sendObject("reasoning_start", startTurn, {});
  emitter.send("reasoning_delta", startTurn, reasoning);
  emitter.sendObject("reasoning_done", startTurn, {});

  // ---- 2. The canvas step opens (a REAL step in the pile) — the stream
  // owns the canvas turn from here (restarts bump it).
  const stream = new CanvasStream(emitter, startTurn + 1, artifact.title);
  stream.open();

  // ---- 3. The updated document streams LIVE into the step (and the open
  // split-view panel, which follows the streaming canvas): every delta is
  // emitted the moment it arrives. Translations run section by section; a
  // content-filter cut restarts the canvas on a fresh turn (validated prefix
  // resent, superseded attempt hidden) and retries the chunk. Other
  // refinements regenerate the whole document with one restart-retry.
  let updatedContent = "";
  let untranslatedSections = 0;
  if (translateLanguage) {
    const result = await translateDocumentSectioned({
      provider,
      stream,
      artifact,
      translateLanguage,
      signal: opts.signal,
    });
    updatedContent = result.content;
    untranslatedSections = result.untranslated;
  } else {
    const refineMessages: LLMMessage[] = [
      { role: "system", content: REFINE_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Requested change: ${instruction}\n\nCurrent document:\n\n${artifact.content}`,
      },
    ];
    // Attempt 1 — the whole updated document streams live.
    let best = await streamChunkLive(provider, refineMessages, stream, {
      signal: opts.signal,
      maxTokens: 8000,
    });
    if (best.clean && best.text.trim().length >= artifact.content.length * 0.35) {
      updatedContent = best.text.trim();
      stream.keep(updatedContent);
    } else {
      // Cut — restart on a fresh turn (prefix resent) and retry once.
      logger.warning("canvas refinement truncated; restarting turn", {
        instruction,
        finish_clean: best.clean,
      });
      stream.restart();
      best = await streamChunkLive(provider, refineMessages, stream, {
        signal: opts.signal,
        maxTokens: 8000,
      });
      if (best.clean && best.text.trim().length >= artifact.content.length * 0.35) {
        updatedContent = best.text.trim();
        stream.keep(updatedContent);
      } else {
        // Degraded path: keep the document unchanged (the step still
        // closes) — restart and write the original content back.
        stream.restart();
        stream.writeFinal(artifact.content);
        stream.writeFinal(
          "\n\n_(the update could not be completed — the document is unchanged)_",
        );
        updatedContent = artifact.content;
        untranslatedSections = 1;
      }
    }
  }

  // ---- 4. The canvas step's cited docs (unchanged set — none carried by
  // the artifact; the original canvas step keeps its own).
  emitter.sendObject("intermediate_report_cited_docs", stream.turn, {
    cited_docs: [],
  });

  return {
    updatedContent,
    answerText: answerText(instruction, translateLanguage, untranslatedSections),
    untranslatedSections,
    answerTurn: stream.turn + 1,
  };
}

/** Stream a short answer text as agent_response packets (chunked lightly). */
export function streamCanvasActionAnswer(
  emitter: StreamEmitter,
  text: string,
  turn: number,
): void {
  emitter.sendObject("agent_response_start", turn, {
    final_documents: [],
    pre_answer_processing_seconds: 0,
  });
  // Light chunking so the answer visibly streams in the chat bubble.
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    const take = rest.length <= 48 ? rest.length : 48;
    let cut = take;
    if (rest.length > take) {
      const space = rest.lastIndexOf(" ", take);
      if (space > 16) cut = space + 1;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  for (const chunk of chunks) {
    emitter.send("agent_response_delta", turn, chunk);
  }
}
