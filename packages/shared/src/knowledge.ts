export type KnowledgeSourceType =
  | "cv"
  | "github"
  | "project"
  | "document"
  | "job_description";

export type KnowledgeSource = {
  id: string;
  sourceType: KnowledgeSourceType;
  sourceName: string;
  originalFilename?: string;
  mimeType?: string;
  rawText: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type KnowledgeChunk = {
  id: string;
  sourceId: string;
  content: string;
  sourceType: KnowledgeSourceType;
  sourceName: string;
  project?: string;
  repository?: string;
  tags: string[];
  metadata: Record<string, unknown>;
  embedding: number[];
};

/** A retrieved chunk with its similarity score against a query embedding. */
export type RetrievedChunk = KnowledgeChunk & {
  /** Cosine similarity, 0-1, higher is more relevant. */
  score: number;
};
