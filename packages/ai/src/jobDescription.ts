import type { JobProfile, LLMProvider, StarStory } from "@interview-copilot/shared";

function buildJobProfileSystemPrompt(): string {
  return `Parse the job description into structured data. Respond with ONLY a single JSON object, no markdown fences, matching exactly this shape:
{"title": string, "company": string | null, "responsibilities": string[], "requiredSkills": string[], "preferredSkills": string[], "technologies": string[], "domain": string[], "keywords": string[]}

Rules:
- "responsibilities": what the role actually does day to day, as short phrases (e.g. "Build production APIs", not full sentences).
- "requiredSkills": explicitly required experience/skills. "preferredSkills": nice-to-have/bonus skills, kept separate from required.
- "technologies": specific named tools/languages/frameworks mentioned (e.g. "PostgreSQL", "React", "Kubernetes").
- "domain": the industry/problem space (e.g. "fintech", "developer tools"), not technologies.
- "keywords": other notable terms worth matching against a candidate's experience.
- If a field has nothing, use an empty array (or null for company).`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Parses raw job description text into a structured JobProfile via the given LLM provider (typically the router). */
export async function parseJobDescription(provider: LLMProvider, text: string): Promise<JobProfile> {
  const parsed = await provider.extractStructured(buildJobProfileSystemPrompt(), text);

  if (!isRecord(parsed)) {
    return {
      title: "Unknown role",
      responsibilities: [],
      requiredSkills: [],
      preferredSkills: [],
      technologies: [],
      domain: [],
      keywords: [],
    };
  }

  return {
    title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title : "Unknown role",
    company: typeof parsed.company === "string" ? parsed.company : undefined,
    responsibilities: toStringArray(parsed.responsibilities),
    requiredSkills: toStringArray(parsed.requiredSkills),
    preferredSkills: toStringArray(parsed.preferredSkills),
    technologies: toStringArray(parsed.technologies),
    domain: toStringArray(parsed.domain),
    keywords: toStringArray(parsed.keywords),
  };
}

function buildLikelyQuestionsSystemPrompt(): string {
  return `Given a job profile and which requirements the candidate has matching experience for, suggest interview questions the candidate should prepare for. Respond with ONLY a single JSON object: {"questions": string[]}. 12-16 realistic, specific questions covering the full role — prioritize the requirements marked as matched (ask about that real experience), the important unmatched ones (the interviewer is likely to probe a gap), and the practical day-to-day of the responsibilities listed. No generic filler like "tell me about yourself".`;
}

export async function generateLikelyQuestions(
  provider: LLMProvider,
  profile: JobProfile,
  matchSummary: string,
): Promise<string[]> {
  const userPrompt = [
    `ROLE: ${profile.title}${profile.company ? ` at ${profile.company}` : ""}`,
    profile.responsibilities.length ? `RESPONSIBILITIES: ${profile.responsibilities.join(", ")}` : "",
    profile.requiredSkills.length ? `REQUIRED SKILLS: ${profile.requiredSkills.join(", ")}` : "",
    profile.technologies.length ? `TECHNOLOGIES: ${profile.technologies.join(", ")}` : "",
    `CANDIDATE MATCH SUMMARY:\n${matchSummary}`,
  ]
    .filter(Boolean)
    .join("\n");

  const parsed = await provider.extractStructured(buildLikelyQuestionsSystemPrompt(), userPrompt);
  if (!isRecord(parsed)) return [];
  return toStringArray(parsed.questions);
}

function buildStarStorySystemPrompt(): string {
  return `Given a candidate's real project/CV content, draft ONE STAR-format story (Situation, Task, Action, Result) that the candidate could tell in an interview. Respond with ONLY a single JSON object: {"situation": string, "task": string, "action": string, "result": string}.

Base every part strictly on the provided content — never invent detail, outcomes, or metrics that aren't present in the text. If the content doesn't fully support one of the four parts, keep it brief and honest (e.g. "Not specified in the available notes") rather than padding it with invented specifics.`;
}

/** Drafts a STAR story from a knowledge source's real stored content — never fabricates beyond what the source text says. */
export async function generateStarStory(
  provider: LLMProvider,
  sourceName: string,
  sourceText: string,
): Promise<StarStory | null> {
  const parsed = await provider.extractStructured(
    buildStarStorySystemPrompt(),
    `PROJECT: ${sourceName}\n\nCONTENT:\n${sourceText.slice(0, 6000)}`,
  );
  if (!isRecord(parsed)) return null;

  return {
    project: sourceName,
    situation: typeof parsed.situation === "string" ? parsed.situation : "",
    task: typeof parsed.task === "string" ? parsed.task : "",
    action: typeof parsed.action === "string" ? parsed.action : "",
    result: typeof parsed.result === "string" ? parsed.result : "",
  };
}
