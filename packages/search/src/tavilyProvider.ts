import type { WebSearchProvider, WebSearchResult } from "./webSearchProvider.js";

/**
 * Tavily — chosen over a keyless option (DuckDuckGo's Instant Answer API
 * was tested directly and found unreliable for general queries; it only
 * returns anything for topics with a Wikipedia-style infobox). Tavily has
 * a real no-credit-card free tier and is purpose-built for this exact
 * "give an LLM current web context" use case.
 */
export class TavilyProvider implements WebSearchProvider {
  constructor(
    private readonly apiKey: string,
    private readonly maxResults = 5,
  ) {}

  async search(query: string): Promise<WebSearchResult[]> {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        query,
        max_results: this.maxResults,
        search_depth: "basic",
      }),
    });

    if (!res.ok) {
      throw new Error(`Tavily search failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as {
      results?: { title: string; url: string; content: string }[];
    };

    return (data.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
    }));
  }
}
