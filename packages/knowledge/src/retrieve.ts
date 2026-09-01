import type { RetrievedChunk } from "@interview-copilot/shared";
import { searchKnowledgeChunks, type SearchOptions } from "@interview-copilot/database";
import { OllamaEmbeddingClient } from "./embeddings.js";

const embeddingClient = new OllamaEmbeddingClient();

/** Embeds a question and retrieves the most relevant stored knowledge chunks. */
export async function retrieveRelevantChunks(
  question: string,
  options: SearchOptions = {},
): Promise<RetrievedChunk[]> {
  const queryEmbedding = await embeddingClient.embed(question);
  return searchKnowledgeChunks(queryEmbedding, options);
}
