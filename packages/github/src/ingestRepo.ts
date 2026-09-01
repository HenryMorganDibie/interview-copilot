import type { LLMProvider } from "@interview-copilot/shared";
import { ingestText, type IngestResult } from "@interview-copilot/knowledge";
import { getRepoMetadata, getRepoReadme } from "./githubClient.js";
import { extractProjectProfile, type ProjectProfile } from "./projectProfile.js";

export type IngestRepoResult = IngestResult & {
  profile: ProjectProfile;
};

/**
 * Ingests a single repository: fetches its README + metadata, extracts a
 * structured project profile (spec section 8 — architecture, tradeoffs,
 * security decisions, etc, not just a raw text dump), and stores the
 * README as a searchable knowledge chunk (sourceType "github") with the
 * profile attached as metadata. Does NOT ingest source code or the full
 * commit/issue history — just the README-level project story, which is
 * what an interview answer actually draws on.
 *
 * `token` is optional: public repos work unauthenticated too (rate-limited
 * but functional), which is how this was tested before OAuth credentials
 * existed.
 */
export async function ingestRepository(
  provider: LLMProvider,
  owner: string,
  repo: string,
  token?: string,
): Promise<IngestRepoResult> {
  const [readme, metadata] = await Promise.all([
    getRepoReadme(owner, repo, token),
    getRepoMetadata(owner, repo, token),
  ]);

  if (!readme) {
    throw new Error(`No README found for ${owner}/${repo} (or repo/README is inaccessible)`);
  }

  const meta = metadata ?? { description: null, language: null, topics: [] };
  const profile = await extractProjectProfile(provider, `${owner}/${repo}`, readme, meta);

  // Fold the structured profile's technologies/security into the ingested
  // text itself, not just the metadata column — job-requirement matching
  // (semantic + keyword) only searches chunk content, not metadata, so a
  // technology the profile correctly identified (e.g. from package.json or
  // repo language, not always spelled out in README prose) would otherwise
  // never surface as a match. Found via live testing: "TypeScript" showed
  // as an unmatched requirement for a repo whose extracted profile clearly
  // listed it as a technology.
  const technologiesLine = profile.technologies.length
    ? `\n\nTechnologies used: ${profile.technologies.join(", ")}`
    : "";
  const securityLine = profile.security.length ? `\nSecurity: ${profile.security.join(", ")}` : "";
  const textToIngest = `${readme}${technologiesLine}${securityLine}`;

  const result = await ingestText({
    text: textToIngest,
    sourceType: "github",
    sourceName: `${owner}/${repo}`,
    mimeType: "text/markdown",
    metadata: { profile, repoUrl: `https://github.com/${owner}/${repo}` },
  });

  return { ...result, profile };
}
