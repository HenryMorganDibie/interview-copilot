import type { JobProfile, JobRequirementMatch, StrongestStory } from "@interview-copilot/shared";
import { keywordSearchKnowledgeChunks } from "@interview-copilot/database";
import { retrieveRelevantChunks } from "./retrieve.js";

/**
 * Deliberately lower than evidence.ts's threshold (0.3) — that one scores
 * full natural-language questions, which embed with much higher absolute
 * cosine similarity against prose content than short skill/requirement
 * phrases do with the same `all-minilm` model. Measured directly: genuinely
 * relevant requirement matches against real CV content scored 0.2-0.4,
 * while clearly irrelevant queries scored 0.02-0.15 — this sits in the gap.
 */
const MATCH_SCORE_THRESHOLD = 0.22;

/**
 * Matches each job responsibility/required skill against the knowledge
 * base. Hybrid: semantic search (works for phrase-length requirements) plus
 * a literal keyword fallback (works for bare single-word skills like "Rust"
 * or "React", which carry too little text for embedding similarity to
 * score reliably — measured directly: those scored just under threshold
 * against CV content that clearly covered them). Runs per requirement —
 * fine for the handful of items a job description has, not something done
 * on every keystroke.
 */
export async function matchJobRequirements(profile: JobProfile): Promise<JobRequirementMatch[]> {
  const requirements = Array.from(new Set([...profile.responsibilities, ...profile.requiredSkills]));

  const matches = await Promise.all(
    requirements.map(async (requirement): Promise<JobRequirementMatch> => {
      const [chunks, keywordHits] = await Promise.all([
        retrieveRelevantChunks(requirement, { limit: 3 }),
        keywordSearchKnowledgeChunks(requirement),
      ]);

      const semanticSources = chunks.filter((c) => c.score >= MATCH_SCORE_THRESHOLD).map((c) => c.sourceName);
      const matchingSources = Array.from(new Set([...semanticSources, ...keywordHits.map((h) => h.sourceName)]));

      return {
        requirement,
        matched: matchingSources.length > 0,
        matchingSources,
      };
    }),
  );

  return matches;
}

/** Renders a short text summary of match results for feeding into an LLM prompt (e.g. likely-questions generation). */
export function summarizeMatches(matches: JobRequirementMatch[]): string {
  return matches
    .map((m) => `${m.matched ? "✓" : "✗"} ${m.requirement}${m.matched ? ` (${m.matchingSources.join(", ")})` : ""}`)
    .join("\n");
}

/** Sources ranked by how many distinct requirements they matched — the candidate's strongest evidence for this role. */
export function rankStrongestStories(matches: JobRequirementMatch[]): StrongestStory[] {
  const counts = new Map<string, number>();
  for (const m of matches) {
    for (const source of m.matchingSources) {
      counts.set(source, (counts.get(source) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([sourceName, matchCount]) => ({ sourceName, matchCount }))
    .sort((a, b) => b.matchCount - a.matchCount);
}

/** Requirements with no matching evidence at all — likely gaps worth an honest, prepared answer. */
export function findWeakAreas(matches: JobRequirementMatch[]): string[] {
  return matches.filter((m) => !m.matched).map((m) => m.requirement);
}
