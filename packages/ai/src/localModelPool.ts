import type {
  AnswerGenerationContext,
  AnswerStreamChunk,
  InterviewAnswer,
  InterviewContext,
  LLMProvider,
  QuestionAnalysis,
} from "@interview-copilot/shared";
import { OllamaProvider } from "./providers/ollamaProvider.js";
import { ProviderHealthTracker } from "./providerHealth.js";
import { discoverOllamaModels, toLocalModelSpecs } from "./ollamaDiscovery.js";

export type LocalModelSpec = {
  model: string;
  /**
   * Static 0-1 quality score for interview-answer suitability (conversational
   * grounding, instruction following) — not raw benchmark accuracy. Coding-
   * tuned models score lower here even if fast, since they tend to answer in
   * code/prose that doesn't fit a spoken interview answer.
   */
  qualityScore: number;
};

type Benchmark = {
  latencyMs: number;
  measuredAt: number;
  ok: boolean;
};

type LocalModelPoolOptions = {
  baseUrl?: string;
  /** Models scoring below this are never selected, however fast. Default 0.5. */
  minQualityScore?: number;
  /** Re-benchmark after this many ms (load/latency drifts over a session). Default 10 min. */
  benchmarkTtlMs?: number;
  /** Short prompt used to time a model; keep it tiny so benchmarking itself stays cheap. */
  benchmarkPrompt?: string;
  /**
   * Once a model benchmarks at or under this latency, stop benchmarking
   * further (untested) models this pass. Without this, a first call that
   * discovers several models could block for minutes trying every one
   * sequentially before ever answering. Untested models are simply not
   * considered until a later re-benchmark. Default 5s.
   */
  goodEnoughLatencyMs?: number;
  /**
   * Caps how long any single local model gets before the router fails over
   * — the spec requires failover on "excessive latency", and a live
   * interview can't wait a minute-plus per model. On this machine's
   * CPU-only hardware, models with hidden reasoning/"thinking" traces
   * (e.g. qwen3) or larger sizes can take 60s+ per cold-loaded reply; a
   * 20s cap means they'll usually benchmark as unhealthy/slow and get
   * ranked behind faster models rather than blocking the session — that's
   * the correct outcome, not a bug to work around with a longer timeout.
   */
  timeoutMs?: number;
};

const DEFAULT_BENCHMARK_PROMPT = "Reply with just the word OK.";

/**
 * Wraps a set of local Ollama models as a single LLMProvider. Benchmarks
 * each model's real latency on this machine, then always routes to the
 * fastest currently-healthy model that meets the quality floor — rather
 * than a fixed "primary model" — so the pool adapts to what's actually
 * fast on this hardware right now.
 */
export class LocalModelPool implements LLMProvider {
  readonly id = "ollama-pool";

  private readonly providers = new Map<string, OllamaProvider>();
  private readonly benchmarks = new Map<string, Benchmark>();
  private readonly health = new ProviderHealthTracker();
  private readonly opts: Required<LocalModelPoolOptions>;
  private benchmarkPromise: Promise<void> | null = null;

  private specs: LocalModelSpec[];
  /** True when no explicit specs were given — models are discovered from `ollama list` on first use, not hardcoded. */
  private readonly dynamic: boolean;
  private discovered = false;

  /**
   * `specs`: explicit model list, or omit/pass `undefined` to discover
   * whatever's actually pulled on this Ollama server at first use — this
   * naturally picks up Ollama's free cloud-hosted models (e.g.
   * `gpt-oss:120b-cloud`) too, not just a hardcoded local model name.
   */
  constructor(specs: LocalModelSpec[] | undefined, opts: LocalModelPoolOptions = {}) {
    this.dynamic = specs === undefined;
    this.specs = specs ?? [];
    this.opts = {
      baseUrl: opts.baseUrl ?? "http://127.0.0.1:11434",
      minQualityScore: opts.minQualityScore ?? 0.5,
      benchmarkTtlMs: opts.benchmarkTtlMs ?? 10 * 60_000,
      benchmarkPrompt: opts.benchmarkPrompt ?? DEFAULT_BENCHMARK_PROMPT,
      goodEnoughLatencyMs: opts.goodEnoughLatencyMs ?? 5_000,
      timeoutMs: opts.timeoutMs ?? 20_000,
    };

    this.registerProviders(this.specs);
  }

  private registerProviders(specs: LocalModelSpec[]): void {
    for (const spec of specs) {
      if (this.providers.has(spec.model)) continue;
      this.providers.set(
        spec.model,
        new OllamaProvider({ model: spec.model, baseUrl: this.opts.baseUrl, timeoutMs: this.opts.timeoutMs }),
      );
    }
  }

  private async ensureDiscovered(): Promise<void> {
    if (!this.dynamic || this.discovered) return;
    const models = await discoverOllamaModels(this.opts.baseUrl);
    this.specs = toLocalModelSpecs(models);
    this.registerProviders(this.specs);
    this.discovered = true;
  }

  /** Times a single generation of the benchmark prompt against one model. */
  private async benchmarkOne(model: string): Promise<Benchmark> {
    const provider = this.providers.get(model);
    if (!provider) return { latencyMs: Infinity, measuredAt: Date.now(), ok: false };

    const start = Date.now();
    try {
      await provider.generateAnswer({
        question: this.opts.benchmarkPrompt,
        analysis: {
          question: this.opts.benchmarkPrompt,
          type: "general_knowledge",
          requiresPersonalExperience: false,
          requiresWebResearch: false,
          topic: "benchmark",
          confidence: 1,
        },
        interviewContext: {
          sessionId: "benchmark",
          recentTranscript: [],
          previousQuestions: [],
          previousAnswers: [],
        },
        evidence: [],
        responseMode: "direct",
      });
      return { latencyMs: Date.now() - start, measuredAt: Date.now(), ok: true };
    } catch {
      return { latencyMs: Infinity, measuredAt: Date.now(), ok: false };
    }
  }

  /**
   * Benchmarks models one at a time — deliberately sequential, not
   * parallel, since local models on a single CPU-only machine compete for
   * the same RAM/CPU and loading several at once starves the larger ones.
   * Stops as soon as a model clears `goodEnoughLatencyMs`; models specs are
   * given in fastest-likely-first order (see toLocalModelSpecs), so this
   * bounds first-call latency instead of always trying every known model.
   * Safe to call directly for a manual, full re-benchmark.
   */
  async benchmarkAll(): Promise<Map<string, Benchmark>> {
    for (const spec of this.specs) {
      const result = await this.benchmarkOne(spec.model);
      this.benchmarks.set(spec.model, result);
      if (result.ok && result.latencyMs <= this.opts.goodEnoughLatencyMs) break;
    }
    return new Map(this.benchmarks);
  }

  private async ensureBenchmarks(): Promise<void> {
    await this.ensureDiscovered();
    if (this.specs.length === 0) return; // nothing to benchmark; pickModel() will correctly find nothing

    const stale =
      this.benchmarks.size === 0 ||
      [...this.benchmarks.values()].some(
        (b) => Date.now() - b.measuredAt > this.opts.benchmarkTtlMs,
      );
    if (!stale) return;

    // Coalesce concurrent callers into a single in-flight benchmark run.
    this.benchmarkPromise ??= this.benchmarkAll()
      .then(() => undefined)
      .finally(() => {
        this.benchmarkPromise = null;
      });
    await this.benchmarkPromise;
  }

  /** Fastest healthy model meeting the quality floor, or undefined if none qualify. */
  private pickModel(): string | undefined {
    const now = Date.now();
    const ranked = this.specs
      .filter((s) => s.qualityScore >= this.opts.minQualityScore)
      .filter((s) => this.health.isAvailable(`ollama:${s.model}`, now))
      .map((s) => ({ model: s.model, benchmark: this.benchmarks.get(s.model) }))
      .filter((s) => s.benchmark?.ok)
      .sort((a, b) => (a.benchmark!.latencyMs - b.benchmark!.latencyMs));

    return ranked[0]?.model;
  }

  async generateAnswer(
    context: AnswerGenerationContext,
    onChunk?: (chunk: AnswerStreamChunk) => void,
  ): Promise<InterviewAnswer> {
    await this.ensureBenchmarks();
    const model = this.pickModel();
    if (!model) throw new Error("LocalModelPool: no local model currently meets the quality/health bar");

    const provider = this.providers.get(model)!;
    try {
      const result = await provider.generateAnswer(context, onChunk);
      this.health.recordSuccess(provider.id);
      return result;
    } catch (error) {
      this.health.recordFailure(provider.id, this.health.classify(error));
      throw error;
    }
  }

  async analyzeQuestion(context: InterviewContext): Promise<QuestionAnalysis> {
    await this.ensureBenchmarks();
    const model = this.pickModel();
    if (!model) throw new Error("LocalModelPool: no local model currently meets the quality/health bar");

    const provider = this.providers.get(model)!;
    try {
      const result = await provider.analyzeQuestion(context);
      this.health.recordSuccess(provider.id);
      return result;
    } catch (error) {
      this.health.recordFailure(provider.id, this.health.classify(error));
      throw error;
    }
  }

  async extractStructured(systemPrompt: string, userPrompt: string): Promise<unknown | null> {
    await this.ensureBenchmarks();
    const model = this.pickModel();
    if (!model) throw new Error("LocalModelPool: no local model currently meets the quality/health bar");

    const provider = this.providers.get(model)!;
    try {
      const result = await provider.extractStructured(systemPrompt, userPrompt);
      this.health.recordSuccess(provider.id);
      return result;
    } catch (error) {
      this.health.recordFailure(provider.id, this.health.classify(error));
      throw error;
    }
  }
}
