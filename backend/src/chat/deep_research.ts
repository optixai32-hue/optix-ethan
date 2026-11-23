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
  return { contextMessages, docs: allDocs, nextTurn: agentTurn };
}
