import type {
  AnswerGenerationContext,
  AnswerStreamChunk,
  InterviewAnswer,
  InterviewContext,
  LLMProvider,
  QuestionAnalysis,
} from "@interview-copilot/shared";
import { ProviderHealthTracker } from "./providerHealth.js";

/**
 * A single LLMProvider backed by an ordered pool of concrete providers.
 * Tries each candidate in order, skipping any currently in cooldown, and
 * fails over silently on timeout/connection error/rate limit/model error —
 * the caller (and the UI) only ever sees one LLMProvider and never learns
 * which underlying model actually answered.
 *
 * Never throws: if every candidate fails, generateAnswer/analyzeQuestion
 * degrade to a safe default rather than stopping the interview session.
 */
export class ProviderRouter implements LLMProvider {
  readonly id = "router";
  private readonly health = new ProviderHealthTracker();

  constructor(private readonly candidates: LLMProvider[]) {
    if (candidates.length === 0) {
      throw new Error("ProviderRouter requires at least one candidate provider");
    }
  }

  /** Health-aware candidates first, then everything else as a last resort so a session never hard-stops. */
  private orderedCandidates(): LLMProvider[] {
    const now = Date.now();
    const available = this.candidates.filter((c) => this.health.isAvailable(c.id, now));
    if (available.length > 0) return available;
    return this.candidates;
  }

  async generateAnswer(
    context: AnswerGenerationContext,
    onChunk?: (chunk: AnswerStreamChunk) => void,
  ): Promise<InterviewAnswer> {
    for (const provider of this.orderedCandidates()) {
      try {
        const result = await provider.generateAnswer(context, onChunk);
        this.health.recordSuccess(provider.id);
        return result;
      } catch (error) {
        this.health.recordFailure(provider.id, this.health.classify(error));
      }
    }

    return {
      answer: "Unable to generate answer.",
      keyPoints: [],
      confidence: 0,
      sources: [],
      reasoningSummary: "All providers were unavailable.",
    };
  }

  async analyzeQuestion(context: InterviewContext): Promise<QuestionAnalysis> {
    for (const provider of this.orderedCandidates()) {
      try {
        const result = await provider.analyzeQuestion(context);
        this.health.recordSuccess(provider.id);
        return result;
      } catch (error) {
        this.health.recordFailure(provider.id, this.health.classify(error));
      }
    }

    return {
      question: context.currentQuestion ?? "",
      type: "unknown",
      requiresPersonalExperience: true,
      requiresWebResearch: false,
      topic: "unknown",
      confidence: 0,
    };
  }

  async extractStructured(systemPrompt: string, userPrompt: string): Promise<unknown | null> {
    for (const provider of this.orderedCandidates()) {
      try {
        const result = await provider.extractStructured(systemPrompt, userPrompt);
        this.health.recordSuccess(provider.id);
        return result;
      } catch (error) {
        this.health.recordFailure(provider.id, this.health.classify(error));
      }
    }
    return null;
  }
}
