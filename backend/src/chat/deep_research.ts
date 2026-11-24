/**
 * Deep Research loop — iterative multi-hop research for the deep_research
 * chat toggle (port scope per PORT_MAP: "deep_research/ | iterative
 * multi-hop research loop").
 *
 * Wire protocol (v5.1.3 web/src/app/app/services/streamingModels.ts):
 *   deep_research_plan_start              {}                    — plan group opens
 *   deep_research_plan_delta {content}    — plan text streams
 *   research_agent_start {research_task}  — one per sub-question
 *   intermediate_report_start             {}
 *   intermediate_report_delta {content}   — sub-report text streams
 *   intermediate_report_cited_docs {cited_docs} — docs backing that report
 *
 * Timeline layout (the original Deep Research step sequence — each phase is
 * its own timeline turn so the frontend renders REAL separate steps):
 *   turn startTurn          : the plan step (DeepResearchPlanRenderer)
 *   turn startTurn + 1 + i  : research agent i (ResearchAgentRenderer) — the
 *                             searches run INSIDE the agent step as nested
 *                             tool rows (sub_turn_index 1 = internal search,
 *                             2 = web search) and the intermediate report
 *                             streams as the agent's parent content
 *   agent loop continues at nextTurn = startTurn + 1 + numQuestions
 *
 * CANVAS phase (runCanvasPhase, after the research agents): the Deep Search
 * canvas — the research brief document — streams as its own REAL timeline
 * step (a research-agent group whose report display renders the canvas
 * markdown with the frontend's expandable modal). The step sequence reads:
 *   Plan -> Research Agent 1..N -> Canvas -> Thinking -> answer -> Done
 * The canvas is also persisted as a chat-session artifact (REST surface)
 * and the final answer references it by title (top-takeaway summary in
 * chat, full brief in the canvas step).
 *
 * SECTION_END for every closed group is injected by the frontend itself
 * (packetProcessor.handleTurnTransition) when the next turn's first packet
 * arrives, so no explicit section_end packets are needed here.
 *
 * Flow: plan -> [per sub-question: search (internal + web) -> intermediate
 * report] -> the collected reports become tool context for the normal agent
 * loop, which writes the final cited answer (process_message.ts).
 */

import { getLogger } from "../utils/logger";
import type { LLMMessage, LLMProvider } from "../llm/types";
import type { SearchDoc } from "../types/domain";
import type { StreamEmitter } from "./emitter";

const logger = getLogger("chat.deep_research");

/**
 * SearchDoc -> SavedSearchDoc (context/search/models.py:456) — local copy of
 * the wire shape used for intermediate_report_cited_docs payloads (kept here
 * to avoid a circular import with process_message.ts).
 */
function toSavedSearchDoc(doc: SearchDoc): Record<string, unknown> {
  return {
    document_id: doc.document_id,
    chunk_ind: doc.chunk_ind ?? doc.chunk_id ?? 0,
    semantic_identifier: doc.semantic_identifier ?? doc.title ?? "",
    link: doc.link ?? null,
    blurb: doc.blurb ?? "",
    source_type: doc.source_type,
    boost: 0,
    hidden: false,
    metadata: doc.metadata ?? {},
    score: doc.score ?? 0,
    is_relevant: true,
    relevance_explanation: "",
    match_highlights: [],
    source_types: null,
    updated_at: doc.doc_updated_at ?? null,
    db_doc_id: 0,
    is_internet: doc.source_type === "web",
  };
}

/**
 * The plan streams into the plan step UI (ExpandableTextDisplay renders the
 * text as markdown), so it MUST be a human-readable numbered list — not the
 * raw JSON array an earlier planner prompt produced. The sub-questions are
 * parsed back out of the same streamed text (parsePlan), keeping one LLM
 * call for both the display and the research loop.
 */
const PLAN_SYSTEM_PROMPT = `You are a research planner. Given the user's question, produce a short research plan: a numbered list of 2-4 focused search questions (one per line) that together cover what is needed to answer it. Each sub-question must be self-contained and answerable by searching documents or the web. Output ONLY the numbered list — no title, no introduction, no prose before or after, no markdown fences.`;

const REPORT_SYSTEM_PROMPT = `You are a research agent writing an intermediate report. Using ONLY the provided search results, write a focused summary (2-4 paragraphs) answering the given sub-question. Cite sources inline as [N] where N is the result number. Be factual and concise. Do not invent information.`;

/** Title for the canvas — the video format: "{Topic}: Research Brief ({Month Year})". */
const CANVAS_TITLE_SYSTEM_PROMPT = `You title research documents. Given the user's question, output ONLY a short document title in the form "{Topic}: Research Brief ({Month Year})" — for example "Elon Musk: Research Brief (November 2026)". Use the current month and year. Keep it under 90 characters. Output the bare title: no quotes, no period, no explanation, nothing else. Write it in the same language as the question.`;

/**
 * The canvas document itself. It streams into the frontend's document
 * display (markdown renderer + expand modal), so the structure must be the
 * exact research-brief shape from the reference: title, prepared date,
 * Question, Executive Summary, Key Findings, ranked source table, Open
 * Questions, Recommendations.
 */
const CANVAS_SYSTEM_PROMPT = `You are producing a research canvas: a self-contained research brief document. It is rendered as markdown, and its [N] citation markers must match the numbered sources list provided EXACTLY (those numbers are shared with the chat's final answer). Write it in the same language as the user's question.

Produce exactly this structure, in this order:

# {document title}
*Prepared {today's date}*

## Question
The user's original question, restated verbatim.

## Executive Summary
3-6 numbered key takeaways, each starting with a **bold headline** followed by 1-2 factual sentences with [N] citations.

## Key Findings
2-4 subsections with ### headings covering the main aspects of the question, with inline [N] citations. Include concrete figures, dates, and names from the evidence.

## Sources
A markdown table of the sources actually cited, columns: | Citation | Title | Source | Link |

## Open Questions
3-5 bullets of unresolved questions or risks.

## Recommendations / Next Steps
2-4 bullets of suggested next steps for the reader.

Rules:
- Use ONLY the provided evidence (research reports and numbered sources). Never invent facts, numbers, or links.
- Cite with [N] markers matching the numbered sources exactly.
- This is a standalone document, not a chat reply: never address the user directly, no greetings, no sign-off.
- Output ONLY the markdown document — no commentary before or after.`;

/**
 * Parse the planner's streamed plan text into sub-questions. Accepts the
 * canonical numbered-list format (also the format shown in the plan step) and
 * falls back to a JSON array if the model produced one anyway.
 */
function parsePlan(text: string): string[] {
  const cleaned = text.replace(/```(?:json|markdown)?/g, "").trim();

  // JSON-array fallback (previous prompt format) — parse first so a model
  // that ignored the list instruction still yields clean questions.
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
      if (Array.isArray(parsed)) {
        const items = parsed
          .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
          .map((q) => q.trim())
          .slice(0, 4);
        if (items.length > 0) return items;
      }
    } catch {
      // fall through to numbered-list parsing
    }
  }

  const questions: string[] = [];
  for (const line of cleaned.split("\n")) {
    const match = line.match(/^\s*(?:\d+[.)]|\d+\s*[-–]|[-*•])\s*(.+)$/);
    if (match && match[1].trim().length > 0) {
      questions.push(match[1].trim());
      if (questions.length >= 4) break;
    }
  }
  return questions;
}

/** Number the docs into an LLM-readable results block (search_tool format). */
function formatResultsBlock(docs: SearchDoc[]): string {
  const lines: string[] = [];
  docs.forEach((doc, idx) => {
    const title = doc.semantic_identifier ?? doc.title ?? doc.document_id;
    const blurb = (doc.blurb ?? "").slice(0, 600);
    const link = doc.link ?? "";
    lines.push(`[${idx + 1}] Title: ${title}\nLink: ${link}\nSource: ${doc.source_type}\nExcerpt: ${blurb}`);
  });
  return lines.join("\n\n");
}

export interface DeepResearchResult {
  /** Report texts appended as tool context for the final answer. */
  contextMessages: LLMMessage[];
  /** All docs gathered (already merged into the caller's citation map). */
  docs: SearchDoc[];
  /** Raw intermediate report texts (input evidence for the canvas phase). */
  reports: string[];
  /** Next free timeline turn after the research phases (agent loop start). */
  nextTurn: number;
}

export async function runDeepResearch(opts: {
  provider: LLMProvider;
  emitter: StreamEmitter;
  query: string;
  history: LLMMessage[];
  /**
   * Runs one round of searches (internal + web) for the sub-question.
   * `agentTurn` is the research agent's timeline turn: the implementation
   * must emit the search tool packets as NESTED groups inside that turn
   * (sub_turn_index 1 = internal search, 2 = web search) so the
   * ResearchAgentRenderer renders them as nested tool rows of the agent step.
   */
  search: (query: string, agentTurn: number) => Promise<SearchDoc[]>;
  mergeDocs: (docs: SearchDoc[]) => void;
  /** Timeline turn the plan step occupies (default 0). */
  startTurn?: number;
  signal?: AbortSignal;
}): Promise<DeepResearchResult> {
  const { provider, emitter, query, search, mergeDocs, signal } = opts;
  const startTurn = opts.startTurn ?? 0;

  // ---- 1. Plan (turn startTurn — the DeepResearchPlanRenderer step)
  const planTurn = startTurn;
  emitter.sendObject("deep_research_plan_start", planTurn, {});
  let planText = "";
  try {
    const planMessages: LLMMessage[] = [
      { role: "system", content: PLAN_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Question: ${query}\n\nConversation context (may be empty):\n${opts.history
          .slice(-6)
          .map((m) => `${m.role}: ${m.content.slice(0, 300)}`)
          .join("\n")}`,
      },
    ];
    for await (const event of provider.stream(planMessages, { signal })) {
      if (event.delta) {
        planText += event.delta;
        emitter.send("deep_research_plan_delta", planTurn, event.delta);
      }
      if (event.done || event.finish_reason === "stop") break;
    }
  } catch (err) {
    logger.warning("deep research planning failed", { error: String(err) });
  }
  const parsedQuestions = parsePlan(planText);
  const questions = parsedQuestions.length > 0 ? parsedQuestions : [query];

  // ---- 2. Research agents: one timeline turn per sub-question
  const allDocs: SearchDoc[] = [];
  const contextMessages: LLMMessage[] = [];
  const reports: string[] = [];
  let agentTurn = startTurn + 1;

  for (const subQuestion of questions) {
    if (signal?.aborted) break;
    // First packet of the (agentTurn, 0) group — classifies the group as a
    // research agent step (ResearchAgentRenderer) and carries its task.
    emitter.sendObject("research_agent_start", agentTurn, {
      research_task: subQuestion,
    });

    let docs: SearchDoc[] = [];
    try {
      docs = await search(subQuestion, agentTurn);
    } catch (err) {
      logger.warning("deep research search failed", {
        question: subQuestion,
        error: String(err),
      });
    }
    // Dedupe against everything gathered so far (citation mapping is shared).
    const known = new Set(allDocs.map((d) => d.document_id));
    const fresh = docs.filter((d) => d && !known.has(d.document_id));
    allDocs.push(...fresh);
    mergeDocs(fresh);

    // Intermediate report — parent packets of the agent group (no
    // sub_turn_index): the renderer streams them as the agent's report.
    emitter.sendObject("intermediate_report_start", agentTurn, {});
    let report = "";
    try {
      const reportMessages: LLMMessage[] = [
        { role: "system", content: REPORT_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Sub-question: ${subQuestion}\n\nOriginal question: ${query}\n\nSearch results:\n${
            formatResultsBlock(fresh) || "(no results found)"
          }`,
        },
      ];
      for await (const event of provider.stream(reportMessages, { signal })) {
        if (event.delta) {
          report += event.delta;
          emitter.send("intermediate_report_delta", agentTurn, event.delta);
        }
        if (event.done || event.finish_reason === "stop") break;
      }
    } catch (err) {
      logger.warning("deep research report failed", {
        question: subQuestion,
        error: String(err),
      });
      report = `Research for "${subQuestion}" could not be completed.`;
    }

    emitter.sendObject("intermediate_report_cited_docs", agentTurn, {
      cited_docs: fresh.map(toSavedSearchDoc),
    });

    contextMessages.push({
      role: "assistant",
      content: `Intermediate research report (${contextMessages.length + 1}/${questions.length}) for "${subQuestion}":\n\n${report}`,
    });
    reports.push(`Sub-question "${subQuestion}":\n${report}`);
    agentTurn += 1;
  }

  // ---- 3. Final-answer context: the reports become conversation context.
  if (contextMessages.length > 0) {
    contextMessages.unshift({
      role: "system",
      content:
        "You have completed deep research. The intermediate research reports above summarize the gathered evidence. Synthesize them into a final cited answer for the user's original question. Keep the [N] citation markers from the reports where they correspond to the final document list.",
    });
  }

  // agentTurn now points at the first turn AFTER the last research agent —
  // exactly where the final-answer agent loop must begin so its Thinking /
  // Web Search / answer steps never collide with the research steps.
  return { contextMessages, docs: allDocs, reports, nextTurn: agentTurn };
}

// ---------------------------------------------------------------------------
// CANVAS PHASE — the Deep Search canvas (research brief document)
// ---------------------------------------------------------------------------

/** Fallback title: "{first words of the query}: Research Brief ({Month Year})". */
function fallbackCanvasTitle(query: string): string {
  const words = query
    .replace(/[\n\r]+/g, " ")
    .split(/\s+/)
    .slice(0, 8)
    .join(" ")
    .replace(/[,.;:!?]+$/, "");
  const now = new Date();
  const month = now.toLocaleString("en-US", { month: "long" });
  return `${words}: Research Brief (${month} ${now.getFullYear()})`;
}

export interface CanvasResult {
  canvasTitle: string;
  canvasContent: string;
  /** Next free timeline turn after the canvas step. */
  nextTurn: number;
}

/** Today's date as "November 24, 2026" for the canvas header line. */
function preparedDate(): string {
  const now = new Date();
  const month = now.toLocaleString("en-US", { month: "long" });
  return `${month} ${now.getDate()}, ${now.getFullYear()}`;
}

/**
 * The canvas phase of Deep Search: the research brief document streams as
 * its own REAL timeline step in the pile (like the Searching-the-web step)
 * — a research-agent group (ResearchAgentRenderer) whose document display
 * renders the canvas markdown with the frontend's expandable modal. The
 * sequence for the whole turn becomes:
 *
 *   Plan -> Research Agent 1..N -> CANVAS -> Thinking -> answer -> Done
 *
 * Packets (all on the canvas's dedicated turn, no sub-turn nesting):
 *   research_agent_start {research_task: "Canvas : {title}"}
 *   intermediate_report_start
 *   intermediate_report_delta {content}  — the canvas streams live
 *   intermediate_report_cited_docs {cited_docs} — the gathered sources
 */
export async function runCanvasPhase(opts: {
  provider: LLMProvider;
  emitter: StreamEmitter;
  query: string;
  /** Raw intermediate research reports (the evidence). */
  reports: string[];
  /** Numbered source list with the GLOBAL citation numbers, "[N] title — link". */
  sourcesBlock: string;
  /** All gathered docs in citation order (for cited_docs). */
  docs: SearchDoc[];
  /** Timeline turn the canvas step occupies. */
  startTurn: number;
  signal?: AbortSignal;
}): Promise<CanvasResult> {
  const { provider, emitter, query, reports, sourcesBlock, docs, startTurn } = opts;

  // ---- 1. Canvas title (fast non-streaming call, deterministic fallback)
  let canvasTitle = "";
  try {
    const titleMsg = await provider.complete(
      [
        { role: "system", content: CANVAS_TITLE_SYSTEM_PROMPT },
        { role: "user", content: query.slice(0, 2000) },
      ],
      { signal: opts.signal, maxTokens: 60 },
    );
    canvasTitle = (titleMsg.content ?? "")
      .replace(/["`]/g, "")
      .replace(/^[\s—–-]+|[\s.]+$/g, "")
      .split("\n")[0]
      .trim()
      .slice(0, 120);
  } catch (err) {
    logger.warning("canvas title generation failed", { error: String(err) });
  }
  if (!canvasTitle) canvasTitle = fallbackCanvasTitle(query);

  // ---- 2. The canvas step opens: a REAL step in the pile (group classified
  // as a research agent by its first packet — research_agent_start).
  emitter.sendObject("research_agent_start", startTurn, {
    research_task: `Canvas : ${canvasTitle}`,
  });
  emitter.sendObject("intermediate_report_start", startTurn, {});

  // ---- 3. The canvas document streams into the step's document display.
  let canvasContent = "";
  try {
    const canvasMessages: LLMMessage[] = [
      { role: "system", content: CANVAS_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Original question: ${query}\n\nToday's date: ${preparedDate()}\n\nDocument title to use as the H1: ${canvasTitle}\n\nIntermediate research reports:\n${
          reports.length > 0 ? reports.join("\n\n") : "(no reports — rely on the sources)"
        }\n\nNumbered sources (use these [N] numbers EXACTLY as-is in your citations):\n${
          sourcesBlock || "(no sources)"
        }`,
      },
    ];
    for await (const event of provider.stream(canvasMessages, {
      signal: opts.signal,
      // The canvas is a full document (findings + ranked source table with
      // URLs); URL-heavy tables tokenize heavily, so leave generous room —
      // truncation mid-table cut the Open Questions/Recommendations sections
      // at lower caps.
      maxTokens: 8000,
    })) {
      if (event.delta) {
        canvasContent += event.delta;
        emitter.send("intermediate_report_delta", startTurn, event.delta);
      }
      if (event.done || event.finish_reason === "stop") break;
    }
  } catch (err) {
    logger.warning("canvas generation failed", { error: String(err) });
  }
  if (!canvasContent.trim()) {
    canvasContent = `# ${canvasTitle}\n\n*Prepared ${preparedDate()}*\n\n_The research canvas could not be completed._`;
    emitter.send("intermediate_report_delta", startTurn, canvasContent);
  }

  // ---- 4. The canvas's cited docs (the sources it was built from).
  emitter.sendObject("intermediate_report_cited_docs", startTurn, {
    cited_docs: docs.map(toSavedSearchDoc),
  });

  return { canvasTitle, canvasContent, nextTurn: startTurn + 1 };
}
