import type {
  AnswerGenerationContext,
  AnswerStreamChunk,
  InterviewAnswer,
  InterviewContext,
  LLMProvider,
  QuestionAnalysis,
} from "@interview-copilot/shared";
import { withTimeout } from "../httpTimeout.js";
import { ProviderRateLimitError } from "../providerHealth.js";
import {
  ANSWER_METADATA_DELIMITER,
  buildAnswerSystemPrompt,
  buildAnswerUserPrompt,
  buildQuestionAnalysisSystemPrompt,
} from "../prompts.js";
import { extractJsonObject, parseSseDataLine, ProseMetadataSplitter, readLines } from "../streaming.js";
import { toFallbackAnswer, toFallbackAnalysis } from "./fallbackParsing.js";

type OpenAiCompatibleOptions = {
  /** Stable id prefix for health tracking/logging, e.g. "groq". */
  providerName: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
};

/**
 * Generic client for any OpenAI-compatible /chat/completions API (Groq,
 * OpenAI itself, etc). One instance = one model, so the router can track
 * and fail over between models independently.
 */
export class OpenAiCompatibleProvider implements LLMProvider {
  readonly id: string;
  private readonly opts: OpenAiCompatibleOptions;

  constructor(opts: OpenAiCompatibleOptions) {
    this.opts = opts;
    this.id = `${opts.providerName}:${opts.model}`;
  }

  private async chat(
    systemPrompt: string,
    userPrompt: string,
    onDelta?: (delta: string) => void,
  ): Promise<string> {
    const { model, baseUrl, apiKey, timeoutMs = 10_000 } = this.opts;

    return withTimeout(timeoutMs, async (signal) => {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          stream: true,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });

      if (res.status === 429) throw new ProviderRateLimitError();
      if (!res.ok || !res.body) {
        throw new Error(`${this.opts.providerName} request failed: ${res.status} ${res.statusText}`);
      }

      let full = "";
      await readLines(res.body, (line) => {
        const payload = parseSseDataLine(line);
        if (!payload) return;
        const delta = (payload as { choices?: { delta?: { content?: string } }[] }).choices?.[0]
          ?.delta?.content;
        if (delta) {
          full += delta;
          onDelta?.(delta);
        }
      });
      return full;
    });
  }

  async analyzeQuestion(context: InterviewContext): Promise<QuestionAnalysis> {
    const question = context.currentQuestion ?? "";
    const raw = await this.chat(buildQuestionAnalysisSystemPrompt(), question);
    return toFallbackAnalysis(extractJsonObject(raw), question);
  }

  async extractStructured(systemPrompt: string, userPrompt: string): Promise<unknown | null> {
    const raw = await this.chat(systemPrompt, userPrompt);
    return extractJsonObject(raw);
  }

  async generateAnswer(
    context: AnswerGenerationContext,
    onChunk?: (chunk: AnswerStreamChunk) => void,
  ): Promise<InterviewAnswer> {
    const splitter = new ProseMetadataSplitter(ANSWER_METADATA_DELIMITER, (proseChunk) => {
      onChunk?.({ delta: proseChunk, done: false });
    });

    await this.chat(buildAnswerSystemPrompt(context.responseMode), buildAnswerUserPrompt(context), (delta) =>
      splitter.push(delta),
    );
    splitter.finish();
    onChunk?.({ delta: "", done: true });

    return toFallbackAnswer(splitter.proseText, splitter.metadataText, context);
  }
}

export function createGroqProvider(model: string, apiKey: string, timeoutMs?: number) {
  return new OpenAiCompatibleProvider({
    providerName: "groq",
    model,
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey,
    timeoutMs,
  });
}

/**
 * OpenCode Zen — https://opencode.ai/zen/v1/chat/completions, standard
 * OpenAI-compatible chat completions. NOT wired into createDefaultRouter's
 * default pool: its free models are limited-time trials whose docs note
 * "data usage implications for model improvement" — i.e. your prompts may
 * be used for training, which conflicts with this app's own rule to never
 * leak candidate data. Use a paid Zen model (or a free one you've reviewed
 * and accepted the tradeoff for) by passing it into createDefaultRouter's
 * groq-style config, or constructing this directly.
 */
export function createOpenCodeZenProvider(model: string, apiKey: string, timeoutMs?: number) {
  return new OpenAiCompatibleProvider({
    providerName: "opencode-zen",
    model,
    baseUrl: "https://opencode.ai/zen/v1",
    apiKey,
    timeoutMs,
  });
}

/**
 * Generic escape hatch: any OpenAI-compatible /chat/completions gateway
 * (OpenRouter, Together, Fireworks, a self-hosted vLLM server, etc) can be
 * added without new code — just supply its base URL, model id, and key.
 */
export function createOpenAiCompatibleProvider(
  providerName: string,
  baseUrl: string,
  model: string,
  apiKey: string,
  timeoutMs?: number,
) {
  return new OpenAiCompatibleProvider({ providerName, baseUrl, model, apiKey, timeoutMs });
}
