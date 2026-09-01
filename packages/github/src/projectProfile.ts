import type { LLMProvider } from "@interview-copilot/shared";

export type ProjectProfile = {
  project: string;
  description: string;
  problemSolved: string;
  architecture: string;
  technologies: string[];
  database: string | null;
  apis: string | null;
  authentication: string | null;
  security: string[];
  infrastructure: string | null;
  testing: string | null;
  deployment: string | null;
  performance: string | null;
  tradeoffs: string | null;
  technicalDecisions: string[];
  challenges: string[];
};

function buildProjectProfileSystemPrompt(): string {
  return `Extract a structured technical profile of this software project from its README and metadata. Respond with ONLY a single JSON object, no markdown fences, matching exactly this shape:
{"project": string, "description": string, "problemSolved": string, "architecture": string, "technologies": string[], "database": string | null, "apis": string | null, "authentication": string | null, "security": string[], "infrastructure": string | null, "testing": string | null, "deployment": string | null, "performance": string | null, "tradeoffs": string | null, "technicalDecisions": string[], "challenges": string[]}

Only state what the README/metadata actually supports — use null or an empty array for anything not mentioned, rather than guessing or inventing detail. Keep each field terse (a sentence or a short list), not a copy of the README.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** Extracts a structured project profile from a repo's README + metadata via the given LLM provider. */
export async function extractProjectProfile(
  provider: LLMProvider,
  repoName: string,
  readmeText: string,
  metadata: { description: string | null; language: string | null; topics: string[] },
): Promise<ProjectProfile> {
  const userPrompt = [
    `REPOSITORY: ${repoName}`,
    metadata.description ? `DESCRIPTION: ${metadata.description}` : "",
    metadata.language ? `PRIMARY LANGUAGE: ${metadata.language}` : "",
    metadata.topics.length ? `TOPICS: ${metadata.topics.join(", ")}` : "",
    `README:\n${readmeText.slice(0, 8000)}`, // cap to keep the prompt reasonably sized
  ]
    .filter(Boolean)
    .join("\n");

  const parsed = await provider.extractStructured(buildProjectProfileSystemPrompt(), userPrompt);

  if (!isRecord(parsed)) {
    return {
      project: repoName,
      description: metadata.description ?? "",
      problemSolved: "",
      architecture: "",
      technologies: metadata.language ? [metadata.language] : [],
      database: null,
      apis: null,
      authentication: null,
      security: [],
      infrastructure: null,
      testing: null,
      deployment: null,
      performance: null,
      tradeoffs: null,
      technicalDecisions: [],
      challenges: [],
    };
  }

  return {
    project: typeof parsed.project === "string" && parsed.project.trim() ? parsed.project : repoName,
    description: typeof parsed.description === "string" ? parsed.description : "",
    problemSolved: typeof parsed.problemSolved === "string" ? parsed.problemSolved : "",
    architecture: typeof parsed.architecture === "string" ? parsed.architecture : "",
    technologies: toStringArray(parsed.technologies),
    database: toNullableString(parsed.database),
    apis: toNullableString(parsed.apis),
    authentication: toNullableString(parsed.authentication),
    security: toStringArray(parsed.security),
    infrastructure: toNullableString(parsed.infrastructure),
    testing: toNullableString(parsed.testing),
    deployment: toNullableString(parsed.deployment),
    performance: toNullableString(parsed.performance),
    tradeoffs: toNullableString(parsed.tradeoffs),
    technicalDecisions: toStringArray(parsed.technicalDecisions),
    challenges: toStringArray(parsed.challenges),
  };
}
