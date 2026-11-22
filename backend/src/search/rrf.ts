/**
 * Reciprocal Rank Fusion — TypeScript port of
 * backend/onyx/tools/tool_implementations/search/search_utils.py
 *   (weighted_reciprocal_rank_fusion L32) with the weighting dropped (unweighted
 *   RRF, as used for the keyword+semantic hybrid merge) and the fusion constant
 *   taken from configs/constants.ts RRF_K (60; the Standard default k is 50-60).
 *
 * Behavior mirrors the Python original:
 *  - dedupe by document identity (document_id + chunk_id)
 *  - fused score = sum over rankings of 1 / (k + rank)  (rank starts at 1)
 *  - first occurrence wins for the returned item object
 *  - sort by fused score desc, tiebreak by best rank within a source list,
 *    then by source index (round-robin fairness across queries)
 */
import type { SearchDoc } from "../types/domain";
import { RRF_K } from "../configs/constants";

function chunkKey(doc: SearchDoc): string {
  return `${doc.document_id}#${doc.chunk_id}`;
}

export function reciprocalRankFusion(
  rankings: SearchDoc[][],
  k: number = RRF_K,
): SearchDoc[] {
  const scores = new Map<string, number>();
  const idToItem = new Map<string, SearchDoc>();
  const idToSourceIndex = new Map<string, number>();
  const idToSourceRank = new Map<string, number>();

  for (let sourceIdx = 0; sourceIdx < rankings.length; sourceIdx++) {
    const result = rankings[sourceIdx];
    for (let rank = 0; rank < result.length; rank++) {
      const item = result[rank];
      const key = chunkKey(item);
      // rank starts at 1 (index 0 is the best hit)
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank + 1));
      if (!idToItem.has(key)) {
        idToItem.set(key, item);
        idToSourceIndex.set(key, sourceIdx);
        idToSourceRank.set(key, rank + 1);
      }
    }
  }

  const sortedKeys = [...scores.keys()].sort((a, b) => {
    const scoreDiff = (scores.get(b) ?? 0) - (scores.get(a) ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    const rankDiff = (idToSourceRank.get(a) ?? 0) - (idToSourceRank.get(b) ?? 0);
    if (rankDiff !== 0) return rankDiff;
    return (idToSourceIndex.get(a) ?? 0) - (idToSourceIndex.get(b) ?? 0);
  });

  return sortedKeys
    .map((key) => idToItem.get(key))
    .filter((doc): doc is SearchDoc => doc !== undefined);
}
