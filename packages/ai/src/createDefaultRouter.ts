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
  const candidates: LLMProvider[] = [
    new LocalModelPool(config.localModels, {
      baseUrl: config.ollamaBaseUrl,
      minQualityScore: config.minLocalQualityScore,
    }),
  ];

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

  return new ProviderRouter(candidates);
}
