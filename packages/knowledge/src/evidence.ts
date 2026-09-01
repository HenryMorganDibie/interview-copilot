import type { EvidenceItem, RetrievedChunk } from "@interview-copilot/shared";

/**
 * Below this similarity score, a chunk is too weakly related to the
 * question to be useful evidence — excluding it keeps the answer generator
 * from being distracted by noise (and, per the "never fabricate experience"
 * rule, weak matches shouldn't be presented as if they support a claim).
 */
const MIN_USEFUL_SCORE = 0.3;
/** Above this, treat the match as strong enough to call "direct" evidence rather than merely "inferred". */
const DIRECT_EVIDENCE_SCORE = 0.5;

/** Converts retrieved knowledge chunks into the Evidence shape the answer generator consumes. */
export function chunksToEvidence(chunks: RetrievedChunk[]): EvidenceItem[] {
  return chunks
    .filter((c) => c.score >= MIN_USEFUL_SCORE)
    .map((c) => ({
      claim: c.content,
      type: c.score >= DIRECT_EVIDENCE_SCORE ? "direct" : "inferred",
      sourceId: c.sourceName,
      confidence: c.score,
    }));
}
