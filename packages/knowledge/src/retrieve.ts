import type { RetrievedChunk } from "@interview-copilot/shared";
import {
  searchKnowledgeChunks,
  fullTextSearchKnowledgeChunks,
  type SearchOptions,
} from "@interview-copilot/database";
import { OllamaEmbeddingClient } from "./embeddings.js";
import { MIN_USEFUL_SCORE } from "./evidence.js";

const embeddingClient = new OllamaEmbeddingClient();

/**
 * Standard constant from the original RRF paper (Cormack et al.) — large
 * enough that rank differences deep in a list barely move the fused score,
 * so one list's rank-50 item doesn't meaningfully outweigh being absent
 * from the other list entirely. Not tuned for this dataset specifically;
 * 60 is the well-established default other RRF implementations use too.
 */
const RRF_K = 60;

/**
 * Fuses two ranked lists by Reciprocal Rank Fusion — a chunk's fused score
 * is the sum of 1/(RRF_K + rank) across every list it appears in. Fusing
 * by rank position (not raw score) sidesteps comparing cosine similarity
 * and text-search rank on two different, incompatible scales.
 *
 * The chunk's own `score` field (cosine similarity) is preserved when the
 * chunk came from semantic search — evidence.ts's direct/inferred
 * thresholds are calibrated against that scale, so overwriting it with the
 * fused score would silently break them. A chunk semantic search never
 * found at all (a text-only hit — exactly the case hybrid retrieval exists
 * for) has no real cosine score to preserve; it's pinned at
 * MIN_USEFUL_SCORE rather than left at whatever ts_rank_cd happened to
 * return, so it's included as real ("inferred", not "direct") evidence
 * without fabricating a semantic-confidence number that was never measured.
 */
function reciprocalRankFusion(semantic: RetrievedChunk[], textSearch: RetrievedChunk[]): RetrievedChunk[] {
  const rrfScore = new Map<string, number>();
  const byId = new Map<string, RetrievedChunk>();

  semantic.forEach((chunk, rank) => {
    byId.set(chunk.id, chunk);
    rrfScore.set(chunk.id, (rrfScore.get(chunk.id) ?? 0) + 1 / (RRF_K + rank + 1));
  });

  textSearch.forEach((chunk, rank) => {
    if (!byId.has(chunk.id)) {
      byId.set(chunk.id, { ...chunk, score: MIN_USEFUL_SCORE });
    }
    rrfScore.set(chunk.id, (rrfScore.get(chunk.id) ?? 0) + 1 / (RRF_K + rank + 1));
  });

  return [...byId.values()].sort((a, b) => (rrfScore.get(b.id) ?? 0) - (rrfScore.get(a.id) ?? 0));
}

/**
 * Hybrid retrieval: embeds the question for cosine-similarity search, runs
 * Postgres full-text search over the same question concurrently, and fuses
 * both ranked lists via RRF. Semantic search alone can score a chunk
 * containing a specific project name or acronym below an unrelated but
 * more "generic-sounding" chunk, since embedding similarity doesn't weight
 * proper nouns heavily; full-text search catches exactly that case, and
 * fusing ranks (not requiring an extra LLM call) keeps this on the fast
 * path that live-session answers depend on.
 */
export async function retrieveRelevantChunks(
  question: string,
  options: SearchOptions = {},
): Promise<RetrievedChunk[]> {
  const finalLimit = options.limit ?? 8;
  // Wider than the final cut in each list -- fusion only helps if there's
  // more to choose from than a plain single-signal top-K would have kept.
  const poolLimit = Math.max(finalLimit * 2, 16);

  const queryEmbedding = await embeddingClient.embed(question);
  const [semantic, textSearch] = await Promise.all([
    searchKnowledgeChunks(queryEmbedding, { ...options, limit: poolLimit }),
    fullTextSearchKnowledgeChunks(question, { ...options, limit: poolLimit }),
  ]);

  return reciprocalRankFusion(semantic, textSearch).slice(0, finalLimit);
}
