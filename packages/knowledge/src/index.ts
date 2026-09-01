export { ingestDocument, ingestText } from "./ingest.js";
export type { IngestDocumentInput, IngestTextInput, IngestResult } from "./ingest.js";
export { retrieveRelevantChunks } from "./retrieve.js";
export { chunksToEvidence } from "./evidence.js";
export {
  matchJobRequirements,
  summarizeMatches,
  rankStrongestStories,
  findWeakAreas,
} from "./jobMatching.js";
export { chunkText } from "./chunker.js";
export { parseDocument } from "./parser.js";
export { OllamaEmbeddingClient } from "./embeddings.js";
