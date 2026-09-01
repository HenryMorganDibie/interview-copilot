import type {
  AnswerGenerationContext,
  AnswerSource,
  InterviewAnswer,
  QuestionAnalysis,
  QuestionType,
} from "@interview-copilot/shared";
import { extractJsonObject } from "../streaming.js";

const VALID_QUESTION_TYPES: readonly QuestionType[] = [
  "behavioral",
  "technical",
  "system_design",
  "product",
  "experience",
  "career",
  "culture",
  "company",
  "follow_up",
  "clarification",
  "general_knowledge",
  "current_information",
  "unknown",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Builds AnswerSource[] from our own evidence layer — never from model output, so a model can't invent a source. */
function sourcesFromEvidence(context: AnswerGenerationContext): AnswerSource[] {
  return context.evidence
    .filter((e) => e.type !== "unknown" && e.sourceId)
    .map((e) => ({
      sourceId: e.sourceId as string,
      sourceName: e.sourceId as string,
      sourceType: "project" as const,
      confidence: e.confidence,
    }));
}

/**
 * Builds the final InterviewAnswer from the prose/metadata split produced by
 * ProseMetadataSplitter. `proseText` is what was already streamed to the UI
 * as the spoken answer; `metadataText` is the trailing JSON (keyPoints,
 * confidence, etc), parsed tolerantly and never trusted for `sources`.
 */
export function toFallbackAnswer(
  proseText: string,
  metadataText: string,
  context: AnswerGenerationContext,
): InterviewAnswer {
  const sources = sourcesFromEvidence(context);
  const answer = proseText.trim();
  const parsed = metadataText ? extractJsonObject(metadataText) : null;

  if (!answer) {
    return {
      answer: "Unable to generate answer.",
      keyPoints: [],
      confidence: 0,
      sources,
      reasoningSummary: "The model returned an empty response.",
    };
  }

  if (!isRecord(parsed)) {
    return {
      answer,
      keyPoints: [],
      confidence: sources.length ? 0.5 : 0.3,
      sources,
      reasoningSummary: undefined,
    };
  }

  const confidence =
    typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
      ? parsed.confidence
      : sources.length
        ? 0.6
        : 0.3;

  return {
    answer,
    keyPoints: Array.isArray(parsed.keyPoints)
      ? parsed.keyPoints.filter((p): p is string => typeof p === "string")
      : [],
    followUp: typeof parsed.followUp === "string" ? parsed.followUp : undefined,
    confidence,
    sources,
    reasoningSummary:
      typeof parsed.reasoningSummary === "string" ? parsed.reasoningSummary : undefined,
  };
}

export function toFallbackAnalysis(parsed: unknown, question: string): QuestionAnalysis {
  if (!isRecord(parsed)) {
    return {
      question,
      type: "unknown",
      requiresPersonalExperience: true,
      requiresWebResearch: false,
      topic: "unknown",
      confidence: 0.2,
    };
  }

  const type =
    typeof parsed.type === "string" && (VALID_QUESTION_TYPES as string[]).includes(parsed.type)
      ? (parsed.type as QuestionType)
      : "unknown";

  return {
    question: typeof parsed.question === "string" ? parsed.question : question,
    type,
    requiresPersonalExperience: Boolean(parsed.requiresPersonalExperience ?? true),
    requiresWebResearch: Boolean(parsed.requiresWebResearch ?? false),
    topic: typeof parsed.topic === "string" ? parsed.topic : "unknown",
    confidence:
      typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
        ? parsed.confidence
        : 0.3,
  };
}
