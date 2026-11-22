/**
 * RAG prompt building — TypeScript port of the Onyx cited-context prompt
 * construction.
 *
 * Sources mirrored:
 *   - backend/onyx/chat/prompt_building.py :: build_cited_context +
 *     build_cited_system_prompt (classic Onyx; the file was removed in this
 *     checkout during the Placement/agent refactor — the numbered-context
 *     format string below mirrors its last published form:
 *     "[{n}]({link}) {date: ...} \n{semantic_identifier: ...} \n{blurb: ...}
 *     \n{content: ...}" joined with blank lines).
 *   - backend/onyx/prompts/chat_prompts.py :: REQUIRE_CITATION_GUIDANCE
 *     (verified verbatim in this checkout, lines 65-70).
 *   - backend/onyx/tools/tool_implementations/utils.py ::
 *     convert_inference_sections_to_llm_string (per-document citation-number
 *     grouping behavior, lines 66-134).
 */

import type { SearchDoc } from "../types/domain.js";

/** Verbatim port of REQUIRE_CITATION_GUIDANCE (onyx/prompts/chat_prompts.py). */
const REQUIRE_CITATION_GUIDANCE = `

CRITICAL: If referencing knowledge from searches, cite relevant statements INLINE using the format [1], [2], [3], etc. to reference the "document" field. \
DO NOT provide any links following the citations. Cite inline as opposed to leaving all citations until the very end of the response.
`;

/** Instruction block prepended to the persona prompt when documents exist. */
const CITED_CONTEXT_HEADER = `
@ Generate an answer for the user's question based only on the Search Documents provided below.
@ If the Search Documents do not contain the information needed to answer the question, say so directly.
@ Keep the answer accurate to the Search Documents — do not add information beyond them.`;

/**
 * Format SearchDocs into the numbered citation context, one block per
 * document (deduplicated by document_id, numbers assigned in encounter
 * order starting at `citationStart` — the grouping behavior of
 * convert_inference_sections_to_llm_string).
 *
 * Returns the context string and the citation number -> document_id mapping.
 */
export function buildCitedContext(
  searchDocs: SearchDoc[],
  citationStart = 1,
): { context: string; citationMapping: Map<number, SearchDoc> } {
  const citationMapping = new Map<number, SearchDoc>();
  const docIdToNumber = new Map<string, number>();
  let nextNumber = citationStart;

  for (const doc of searchDocs) {
    if (docIdToNumber.has(doc.document_id)) continue;
    docIdToNumber.set(doc.document_id, nextNumber);
    citationMapping.set(nextNumber, doc);
    nextNumber += 1;
  }

  const contextBits = searchDocs.map((doc) => {
    const ind = docIdToNumber.get(doc.document_id) ?? citationStart;
    // link either takes the user to the source or to a page with more info
    const sourceStr = doc.link ? `[${ind}](${doc.link})` : `[${ind}]`;
    return (
      `${sourceStr} {date: ${doc.doc_updated_at ?? "N/A"}} \n` +
      `{semantic_identifier: ${doc.semantic_identifier}} \n` +
      `{source_type: ${doc.source_type}} \n` +
      `{blurb: ${doc.blurb}} \n` +
      `{content: ${doc.content}}`
    );
  });

  return { context: contextBits.join("\n\n"), citationMapping };
}

/**
 * The cited system prompt: persona system prompt + instructions + numbered
 * context. Port of build_cited_system_prompt (classic prompt_building.py):
 * when no documents exist the system prompt is returned unchanged.
 */
export function buildCitedSystemPrompt(
  systemPrompt: string,
  searchDocs: SearchDoc[],
): string {
  if (!searchDocs || searchDocs.length === 0) {
    return systemPrompt;
  }
  const { context } = buildCitedContext(searchDocs, 1);
  return `${systemPrompt}\n${CITED_CONTEXT_HEADER}\n${REQUIRE_CITATION_GUIDANCE}\n\n# Search Documents\n\n${context}`;
}
