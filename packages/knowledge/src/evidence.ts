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

/**
 * Above this, a match is strong enough to trust even for a question the
 * analyzer flagged as probably not about personal experience (e.g.
 * "what's new in Next.js?"). Higher than MIN_USEFUL_SCORE on purpose: found
 * via evaluation that a merely-weak match (just above 0.3) can still sneak
 * through for a genuinely unrelated question, attaching a misleading
 * "source" to an answer that isn't actually grounded in anything personal.
 * Retrieval still always runs regardless of that flag — the analyzer's
 * classification isn't reliable enough to hard-gate on (a second eval run
 * showed real personal questions occasionally misclassified), so this
 * raises the bar rather than skipping evidence outright.
 */
const STRICT_USEFUL_SCORE = 0.5;

/** Converts retrieved knowledge chunks into the Evidence shape the answer generator consumes. */
export function chunksToEvidence(chunks: RetrievedChunk[], strict = false): EvidenceItem[] {
  const threshold = strict ? STRICT_USEFUL_SCORE : MIN_USEFUL_SCORE;
  return chunks
    .filter((c) => c.score >= threshold)
    .map((c) => ({
      claim: c.content,
      type: c.score >= DIRECT_EVIDENCE_SCORE ? "direct" : "inferred",
      sourceId: c.sourceName,
      confidence: c.score,
    }));
}
