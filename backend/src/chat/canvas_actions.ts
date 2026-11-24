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
 *   2. a NEW canvas timeline step — the updated document streams live into
 *      the open split-view panel (a real step in the pile, like the original
 *      canvas step)
 *   3. the artifact row is updated (the canvas persists with the session)
 *   4. a brief answer streams in the chat (the bot "répond")
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

/**
 * Translate/refine ONE chunk through the provider, WITHOUT emitting deltas —
 * the caller streams the accepted text itself so a content-filter truncation
 * (the upstream `finish_reason: "sensitive"` fired on some CJK outputs,
 * cutting mid-document) never reaches the canvas: the chunk is retried, and
 * falls back to its original text, before anything is emitted.
 */
async function runChunk(
  provider: LLMProvider,
  messages: LLMMessage[],
  opts: {
    signal?: AbortSignal;
    maxTokens: number;
  },
): Promise<{ text: string; filtered: boolean }> {
  let text = "";
  let filtered = false;
  try {
    for await (const event of provider.stream(messages, {
      signal: opts.signal,
      maxTokens: opts.maxTokens,
    })) {
      if (event.delta) text += event.delta;
      if (
        event.finish_reason &&
        event.finish_reason !== "stop" &&
        event.finish_reason !== "tool_calls"
      ) {
        // "sensitive" / "length" / … — the upstream cut the generation.
        filtered = true;
      }
      if (event.done || event.finish_reason === "stop") break;
    }
  } catch (err) {
    logger.warning("canvas action chunk generation failed", {
      error: String(err),
    });
    return { text: "", filtered: true };
  }
  return { text, filtered };
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
 * Emit finalized text into the canvas step as small deltas — the document
 * visibly writes line by line instead of landing as one block (the reference
 * video's progressive canvas). Line-boundary chunks keep markdown intact.
 */
function emitChunked(emitter: StreamEmitter, turn: number, text: string): void {
  if (!text) return;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    emitter.send("intermediate_report_delta", turn, i === 0 ? lines[i] : `\n${lines[i]}`);
  }
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
}

/**
 * Translate the artifact section by section — the only reliable way past the
 * upstream content filter, which truncates some whole-document CJK
 * translations mid-flight (`finish_reason: "sensitive"`): each section is
 * translated on its own, integrity-checked (a CJK target naturally compresses
 * to ~30% of the source's characters), retried once, and — when the filter
 * still cuts it — kept in the document's original language so the canvas
 * NEVER ends up truncated. Accepted sections stream into the canvas as they
 * finalize, so the panel still writes progressively.
 */
async function translateDocumentSectioned(opts: {
  provider: LLMProvider;
  emitter: StreamEmitter;
  turn: number;
  artifact: { title: string; content: string };
  translateLanguage: string;
  signal?: AbortSignal;
}): Promise<{ content: string; untranslated: number }> {
  const { provider, emitter, turn, artifact, translateLanguage, signal } = opts;
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

    let best = await runChunk(provider, messages, { signal, maxTokens: 8000 });
    if (
      best.filtered ||
      translationLooksTruncated(section, best.text, cjkTarget)
    ) {
      logger.warning("canvas translation section truncated; retrying once", {
        section: section.slice(0, 60),
        finish_filtered: best.filtered,
      });
      const retry = await runChunk(provider, messages, {
        signal,
        maxTokens: 8000,
      });
      if (retry.text.length > best.text.length) best = retry;
    }

    let accepted: string;
    if (
      best.filtered ||
      translationLooksTruncated(section, best.text, cjkTarget)
    ) {
      // The filter cut this section twice — keep the original text: a
      // complete document with one section in its original language beats
      // a truncated translation.
      accepted = section;
      untranslated += 1;
    } else {
      accepted = best.text.trimEnd();
    }

    out.push(accepted);
    // Stream the accepted section into the canvas (chunked so it visibly
    // writes; the separator keeps the markdown structure).
    emitChunked(emitter, turn, accepted);
    emitChunked(emitter, turn, "\n\n");
  }

  return { content: out.join("\n\n").trimEnd(), untranslated };
}

/**
 * Run a canvas toolbar action: stream the updated document as a REAL canvas
 * timeline step (research_agent_start "Canvas : {title}" group, exactly like
 * the Deep Search canvas phase) and return the texts the caller persists.
 *
 * Packet timeline (turns): reasoning on `startTurn`, the canvas step on
 * `startTurn + 1`; the caller streams the answer on `startTurn + 2`.
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

  // ---- 2. The canvas step opens (a REAL step in the pile).
  const canvasTurn = startTurn + 1;
  emitter.sendObject("research_agent_start", canvasTurn, {
    research_task: `Canvas : ${artifact.title}`,
  });
  emitter.sendObject("intermediate_report_start", canvasTurn, {});

  // ---- 3. The updated document streams live into the step (and the open
  // split-view panel, which follows the streaming canvas). Translations run
  // section by section — each section streams into the canvas the moment it
  // is finalized (progressive writing), the upstream content filter cannot
  // truncate the document (a filtered section is retried, then kept in the
  // original language), and no partial text is ever emitted before its
  // section is validated. Other refinements regenerate the whole document
  // with one integrity retry.
  let updatedContent = "";
  let untranslatedSections = 0;
  if (translateLanguage) {
    const result = await translateDocumentSectioned({
      provider,
      emitter,
      turn: canvasTurn,
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
    let best = await runChunk(provider, refineMessages, {
      signal: opts.signal,
      maxTokens: 8000,
    });
    if (best.filtered || best.text.length < artifact.content.length * 0.35) {
      const retry = await runChunk(provider, refineMessages, {
        signal: opts.signal,
        maxTokens: 8000,
      });
      if (retry.text.length > best.text.length) best = retry;
    }
    if (best.filtered || best.text.length < artifact.content.length * 0.35) {
      // Degraded path: keep the document unchanged (the step still closes).
      updatedContent = artifact.content;
      untranslatedSections = 1;
      emitChunked(emitter, canvasTurn, updatedContent);
      emitChunked(
        emitter,
        canvasTurn,
        "\n\n_(the update could not be completed — the document is unchanged)_",
      );
    } else {
      updatedContent = best.text.trim();
      emitChunked(emitter, canvasTurn, updatedContent);
    }
  }

  // ---- 4. The canvas step's cited docs (unchanged set — none carried by
  // the artifact; the original canvas step keeps its own).
  emitter.sendObject("intermediate_report_cited_docs", canvasTurn, {
    cited_docs: [],
  });

  return {
    updatedContent,
    answerText: answerText(instruction, translateLanguage, untranslatedSections),
    untranslatedSections,
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
