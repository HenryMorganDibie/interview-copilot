export type { WebSearchProvider, WebSearchResult } from "./webSearchProvider.js";
export { formatWebResearch } from "./webSearchProvider.js";
export { TavilyProvider } from "./tavilyProvider.js";

import type { WebSearchProvider } from "./webSearchProvider.js";
import { TavilyProvider } from "./tavilyProvider.js";

/** Returns a configured provider, or null if no search API key is set — callers should degrade gracefully, not fail the request. */
export function createDefaultSearchProvider(apiKey: string | undefined): WebSearchProvider | null {
  if (!apiKey) return null;
  return new TavilyProvider(apiKey);
}
