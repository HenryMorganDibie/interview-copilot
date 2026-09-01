import type { KnowledgeSourceType } from "@interview-copilot/shared";
import { insertKnowledgeChunks, insertKnowledgeSource } from "@interview-copilot/database";
import { parseDocument } from "./parser.js";
import { chunkText } from "./chunker.js";
import { OllamaEmbeddingClient } from "./embeddings.js";

export type IngestDocumentInput = {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  sourceType: KnowledgeSourceType;
  sourceName: string;
};

export type IngestTextInput = {
  text: string;
  mimeType?: string;
  originalFilename?: string;
  sourceType: KnowledgeSourceType;
  sourceName: string;
  metadata?: Record<string, unknown>;
};

export type IngestResult = {
  sourceId: string;
  chunkCount: number;
};

const embeddingClient = new OllamaEmbeddingClient();

/** File-based ingestion (upload flow): Source -> Parser -> Normalizer -> Chunker -> Embedding -> Vector database. */
export async function ingestDocument(input: IngestDocumentInput): Promise<IngestResult> {
  const parsed = await parseDocument(input.buffer, input.filename, input.mimeType);
  return ingestText({
    text: parsed.text,
    mimeType: parsed.mimeType,
    originalFilename: input.filename,
    sourceType: input.sourceType,
    sourceName: input.sourceName,
  });
}

/**
 * Text-based ingestion — same pipeline as ingestDocument minus the parse
 * step, for sources that already come in as plain text (GitHub READMEs,
 * pasted job descriptions, etc) rather than an uploaded file. Never leaves
 * partial chunks with no source — chunks are only inserted after the
 * source row commits.
 */
export async function ingestText(input: IngestTextInput): Promise<IngestResult> {
  const normalized = normalizeText(input.text);
  if (!normalized.trim()) {
    throw new Error(`No extractable text found for ${input.sourceName}`);
  }

  const source = await insertKnowledgeSource({
    sourceType: input.sourceType,
    sourceName: input.sourceName,
    originalFilename: input.originalFilename,
    mimeType: input.mimeType,
    rawText: normalized,
    metadata: input.metadata,
  });

  const chunks = chunkText(normalized);
  const embeddings = await embeddingClient.embedBatch(chunks);

  await insertKnowledgeChunks(
    chunks.map((content, i) => ({
      sourceId: source.id,
      content,
      embedding: embeddings[i],
    })),
  );

  return { sourceId: source.id, chunkCount: chunks.length };
}

/** Collapses excess whitespace/blank lines from raw extracted text. */
function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
