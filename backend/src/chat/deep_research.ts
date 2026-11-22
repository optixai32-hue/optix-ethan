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

const PLAN_SYSTEM_PROMPT = `You are a research planner. Given the user's question, produce a short research plan as a JSON array of 2-4 focused search sub-questions (strings). Each sub-question must be self-contained and answerable by searching documents or the web. Output ONLY the JSON array, no prose, no markdown fences.`;

const REPORT_SYSTEM_PROMPT = `You are a research agent writing an intermediate report. Using ONLY the provided search results, write a focused summary (2-4 paragraphs) answering the given sub-question. Cite sources inline as [N] where N is the result number. Be factual and concise. Do not invent information.`;

/** Parse the planner's JSON array out of a possibly noisy LLM response. */
function parsePlan(text: string): string[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    const items = parsed
      .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      .map((q) => q.trim())
      .slice(0, 4);
    return items;
  } catch {
    return [];
  }
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
}

export async function runDeepResearch(opts: {
  provider: LLMProvider;
  emitter: StreamEmitter;
  query: string;
  history: LLMMessage[];
  search: (query: string) => Promise<SearchDoc[]>;
  mergeDocs: (docs: SearchDoc[]) => void;
  signal?: AbortSignal;
}): Promise<DeepResearchResult> {
  const { provider, emitter, query, search, mergeDocs, signal } = opts;

  // ---- 1. Plan (streamed into the plan group)
  emitter.sendObject("deep_research_plan_start", 0, {});
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
        emitter.send("deep_research_plan_delta", 0, event.delta);
      }
      if (event.done || event.finish_reason === "stop") break;
    }
  } catch (err) {
    logger.warning("deep research planning failed", { error: String(err) });
  }
  const subQuestions = parsePlan(planText);
  const questions = subQuestions.length > 0 ? subQuestions : [query];

  // ---- 2. Per sub-question: search + intermediate report
  const allDocs: SearchDoc[] = [];
  const contextMessages: LLMMessage[] = [];

  for (let i = 0; i < questions.length; i += 1) {
    if (signal?.aborted) break;
    const subQuestion = questions[i];
    emitter.sendObject("research_agent_start", 0, {
      research_task: subQuestion,
    });

    let docs: SearchDoc[] = [];
    try {
      docs = await search(subQuestion);
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

    emitter.sendObject("intermediate_report_start", 0, {});
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
          emitter.send("intermediate_report_delta", 0, event.delta);
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

    emitter.sendObject("intermediate_report_cited_docs", 0, {
      cited_docs: fresh.map(toSavedSearchDoc),
    });

    contextMessages.push({
      role: "assistant",
      content: `Intermediate research report (${i + 1}/${questions.length}) for "${subQuestion}":\n\n${report}`,
    });
  }

  // ---- 3. Final-answer context: the reports become conversation context.
  if (contextMessages.length > 0) {
    contextMessages.unshift({
      role: "system",
      content:
        "You have completed deep research. The intermediate research reports above summarize the gathered evidence. Synthesize them into a final cited answer for the user's original question. Keep the [N] citation markers from the reports where they correspond to the final document list.",
    });
  }

  return { contextMessages, docs: allDocs };
}
