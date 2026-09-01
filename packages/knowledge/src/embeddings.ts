export type EmbeddingClientOptions = {
  baseUrl?: string;
  model?: string;
};

/**
 * Embeds text via a local Ollama model (default `all-minilm`, 384 dims,
 * ~45MB, zero API cost). Kept as its own small client rather than reusing
 * packages/ai's chat-oriented OllamaProvider — embeddings are a different
 * endpoint/response shape, not a chat completion.
 */
export class OllamaEmbeddingClient {
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(options: EmbeddingClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "http://127.0.0.1:11434";
    this.model = options.model ?? "all-minilm";
  }

  async embed(text: string): Promise<number[]> {
    const [vector] = await this.embedBatch([text]);
    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!res.ok) {
      throw new Error(`Embedding request failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { embeddings?: number[][] };
    if (!data.embeddings || data.embeddings.length !== texts.length) {
      throw new Error("Embedding response did not match input count");
    }
    return data.embeddings;
  }
}
