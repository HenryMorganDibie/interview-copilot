export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export interface WebSearchProvider {
  search(query: string): Promise<WebSearchResult[]>;
}

/** Renders results as plain text suitable for the "WEB RESEARCH" section of the answer-generation prompt. */
export function formatWebResearch(results: WebSearchResult[]): string {
  if (results.length === 0) return "No web results found.";
  return results
    .map((r) => `- ${r.title} (${r.url}): ${r.snippet}`)
    .join("\n");
}
