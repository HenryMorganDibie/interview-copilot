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

type AnthropicProviderOptions = {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
};

/**
 * Optional provider kept behind the same LLMProvider interface so an
 * Anthropic API key can be added later without changing the router or any
 * other code. Not included in the default pool (see router.ts) — the
 * default setup runs entirely on Ollama + Groq at zero cost.
 */
export class AnthropicProvider implements LLMProvider {
  readonly id: string;
  private readonly opts: Required<AnthropicProviderOptions>;

  constructor(opts: AnthropicProviderOptions) {
    this.opts = {
      model: opts.model ?? "claude-sonnet-5",
      timeoutMs: opts.timeoutMs ?? 10_000,
      apiKey: opts.apiKey,
    };
    this.id = `anthropic:${this.opts.model}`;
  }

  private async chat(
    systemPrompt: string,
    userPrompt: string,
    onDelta?: (delta: string) => void,
  ): Promise<string> {
    const { model, apiKey, timeoutMs } = this.opts;

    return withTimeout(timeoutMs, async (signal) => {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          stream: true,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });

      if (res.status === 429) throw new ProviderRateLimitError();
      if (!res.ok || !res.body) {
        throw new Error(`Anthropic request failed: ${res.status} ${res.statusText}`);
      }

      let full = "";
      await readLines(res.body, (line) => {
        const payload = parseSseDataLine(line);
        if (!payload) return;
        const event = payload as { type?: string; delta?: { text?: string } };
        if (event.type === "content_block_delta" && event.delta?.text) {
          full += event.delta.text;
          onDelta?.(event.delta.text);
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
