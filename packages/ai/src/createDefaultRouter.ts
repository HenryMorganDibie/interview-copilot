import type { LLMProvider } from "@interview-copilot/shared";
import { LocalModelPool, type LocalModelSpec } from "./localModelPool.js";
import { createGroqProvider } from "./providers/openAiCompatibleProvider.js";
import { AnthropicProvider } from "./providers/anthropicProvider.js";
import { ProviderRouter } from "./router.js";

export type DefaultRouterConfig = {
  /**
   * Explicit local model list. Omit to discover whatever's actually pulled
   * on the Ollama server at runtime (via `ollama list`) instead of a
   * hardcoded name — this naturally picks up any free model the user has
   * installed, including Ollama's free cloud-hosted models.
   */
  localModels?: LocalModelSpec[];
  ollamaBaseUrl?: string;
  /** Models below this quality floor are never selected, however fast. Default 0.5. */
  minLocalQualityScore?: number;
  groqApiKey?: string;
  /** Ordered strongest-first; defaults to the two live Groq models suited to reasoning. */
  groqModels?: string[];
  anthropicApiKey?: string;
  anthropicModel?: string;
  /**
   * `true` (default): local pool tried first. `false`: skip it entirely.
   * `"last"`: skip it for the common case but keep it as a final fallback
   * after every remote candidate has failed.
   *
   * On CPU-only/low-RAM machines a cold local-model load can take several
   * seconds before the router gives up and fails over (measured: this
   * dominated the P90/max tail in docs/eval/RESULTS.md) — unacceptable for
   * a live interview answer, where the candidate is visibly waiting. But a
   * live-session router with `false` and no local pool at all has no
   * fallback left once its remote candidates are exhausted (Groq's free
   * tier is 8K TPM — a burst of rapid live questions can trip it, and
   * gpt-oss-120b/20b share that ceiling), and silently degrades to
   * "Unable to generate answer." for the rest of the rate-limit window —
   * confirmed live via docs/eval/run-eval.mjs on 2026-09-05, where 12/17
   * answer-eval questions returned confidence 0 once Groq's TPM budget was
   * exhausted partway through the run. Use `"last"` for latency-critical
   * live-session calls instead of `false`: same fast path in the common
   * case, but a real (slower) grounded answer instead of a hard failure
   * when the fast tier is genuinely down. Leave it `true` (default) for
   * prep-time generation, where the free local model is worth trying first.
   */
  includeLocalPool?: boolean | "last";
};

/**
 * Builds the default provider pool: a benchmarked local Ollama model pool
 * first (free, no network for genuinely local models; picks the fastest
 * model that clears the quality floor, discovered dynamically), then Groq
 * free-tier models as fallback, in the order given. Anthropic is wired up
 * only if an API key is supplied — the app runs with zero paid API usage
 * by default.
 */
export function createDefaultRouter(config: DefaultRouterConfig = {}): ProviderRouter {
  const candidates: LLMProvider[] = [];
  const buildLocalPool = () =>
    new LocalModelPool(config.localModels, {
      baseUrl: config.ollamaBaseUrl,
      minQualityScore: config.minLocalQualityScore,
    });

  if (config.includeLocalPool !== false && config.includeLocalPool !== "last") {
    candidates.push(buildLocalPool());
  }

  if (config.groqApiKey) {
    const models = config.groqModels ?? ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];
    for (const model of models) {
      candidates.push(createGroqProvider(model, config.groqApiKey));
    }
  }

  if (config.anthropicApiKey) {
    candidates.push(
      new AnthropicProvider({ apiKey: config.anthropicApiKey, model: config.anthropicModel }),
    );
  }

  if (config.includeLocalPool === "last") {
    candidates.push(buildLocalPool());
  }

  return new ProviderRouter(candidates);
}
