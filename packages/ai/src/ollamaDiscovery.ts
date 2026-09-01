import type { LocalModelSpec } from "./localModelPool.js";

type OllamaTagsModel = {
  name: string;
  remote_host?: string;
  details?: { family?: string; parameter_size?: string };
};

export type DiscoveredOllamaModel = {
  name: string;
  family?: string;
  parameterSize?: string;
  /** True for Ollama's free cloud-hosted models (proxied through the local daemon to ollama.com), not CPU-bound on this machine. */
  isCloud: boolean;
};

/** Lists whatever models are actually pulled/available on this Ollama server right now. */
export async function discoverOllamaModels(
  baseUrl = "http://127.0.0.1:11434",
): Promise<DiscoveredOllamaModel[]> {
  const res = await fetch(`${baseUrl}/api/tags`);
  if (!res.ok) return [];

  const data = (await res.json()) as { models?: OllamaTagsModel[] };
  return (data.models ?? []).map((m) => ({
    name: m.name,
    family: m.details?.family,
    parameterSize: m.details?.parameter_size,
    isCloud: Boolean(m.remote_host) || m.name.endsWith("-cloud"),
  }));
}

/**
 * Heuristic 0-1 quality score for conversational interview answers — not a
 * raw capability benchmark. Code-tuned models tend to answer in code/terse
 * fragments rather than natural spoken prose, so they score lower here even
 * though they may be strong at coding tasks. Cloud-hosted models are usually
 * larger/more capable and aren't limited by this machine's CPU, so they get
 * a boost; they're still tracked through the same health/rate-limit system
 * as everything else, since Ollama's cloud proxy has its own quota.
 */
export function scoreModelQuality(model: DiscoveredOllamaModel): number {
  const name = model.name.toLowerCase();
  if (name.includes("coder") || name.includes("code")) return 0.5;
  if (model.isCloud) return 0.85;
  return 0.7;
}

function parseParamCount(size: string | undefined): number {
  const match = size?.match(/([\d.]+)\s*B/i);
  return match ? parseFloat(match[1]) : Infinity;
}

/**
 * Converts discovered models into LocalModelPool specs, using the heuristic
 * quality scorer, and ordered smallest-parameter-count first as a cheap
 * speed proxy — LocalModelPool benchmarks in this order and stops early
 * once a fast-enough model is found, so trying likely-fast models first
 * bounds how long that takes.
 */
export function toLocalModelSpecs(models: DiscoveredOllamaModel[]): LocalModelSpec[] {
  return [...models]
    .sort((a, b) => parseParamCount(a.parameterSize) - parseParamCount(b.parameterSize))
    .map((m) => ({ model: m.name, qualityScore: scoreModelQuality(m) }));
}
