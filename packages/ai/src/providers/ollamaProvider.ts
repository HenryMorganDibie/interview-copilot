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
import { extractJsonObject, ProseMetadataSplitter, readLines } from "../streaming.js";
import { toFallbackAnswer, toFallbackAnalysis } from "./fallbackParsing.js";

type OllamaProviderOptions = {
  model: string;
  baseUrl?: string;
  /** Answer generation is on the critical path; keep this tight (default 8s). */
  timeoutMs?: number;
};

/** Local Ollama server, OpenAI-independent. Talks to /api/chat (NDJSON streaming). */
export class OllamaProvider implements LLMProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: OllamaProviderOptions) {
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? "http://127.0.0.1:11434";
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.id = `ollama:${this.model}`;
  }

  private async chat(
    systemPrompt: string,
    userPrompt: string,
    onDelta?: (delta: string) => void,
  ): Promise<string> {
    return withTimeout(this.timeoutMs, async (signal) => {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: true,
          // Reasoning models (e.g. qwen3) can spend tens of seconds on hidden
          // chain-of-thought before answering; that's fatal for live-interview
          // latency, so always disable it. Ignored by non-reasoning models.
          think: false,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });

      if (res.status === 429) throw new ProviderRateLimitError();
      if (!res.ok || !res.body) {
        throw new Error(`Ollama request failed: ${res.status} ${res.statusText}`);
      }

      let full = "";
      await readLines(res.body, (line) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        const content = (parsed as { message?: { content?: string } }).message?.content;
        if (content) {
          full += content;
          onDelta?.(content);
        }
      });
      return full;
    });
  }

  async analyzeQuestion(context: InterviewContext): Promise<QuestionAnalysis> {
    const question = context.currentQuestion ?? "";
    const raw = await this.chat(buildQuestionAnalysisSystemPrompt(), question);
    const parsed = extractJsonObject(raw);
    return toFallbackAnalysis(parsed, question);
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
