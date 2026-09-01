import type { KnowledgeSource, KnowledgeSourceType, RetrievedChunk } from "@interview-copilot/shared";
import { getPool } from "./pool.js";

type InsertSourceInput = {
  sourceType: KnowledgeSourceType;
  sourceName: string;
  originalFilename?: string;
  mimeType?: string;
  rawText: string;
  metadata?: Record<string, unknown>;
};

export async function insertKnowledgeSource(input: InsertSourceInput): Promise<KnowledgeSource> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string;
    source_type: KnowledgeSourceType;
    source_name: string;
    original_filename: string | null;
    mime_type: string | null;
    raw_text: string;
    metadata: Record<string, unknown>;
    created_at: string;
  }>(
    `INSERT INTO knowledge_sources (source_type, source_name, original_filename, mime_type, raw_text, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, source_type, source_name, original_filename, mime_type, raw_text, metadata, created_at`,
    [
      input.sourceType,
      input.sourceName,
      input.originalFilename ?? null,
      input.mimeType ?? null,
      input.rawText,
      JSON.stringify(input.metadata ?? {}),
    ],
  );

  const row = rows[0];
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceName: row.source_name,
    originalFilename: row.original_filename ?? undefined,
    mimeType: row.mime_type ?? undefined,
    rawText: row.raw_text,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

type InsertChunkInput = {
  sourceId: string;
  content: string;
  project?: string;
  repository?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  embedding: number[];
};

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export async function insertKnowledgeChunks(chunks: InsertChunkInput[]): Promise<void> {
  if (chunks.length === 0) return;
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    for (const chunk of chunks) {
      await client.query(
        `INSERT INTO knowledge_chunks (source_id, content, project, repository, tags, metadata, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
        [
          chunk.sourceId,
          chunk.content,
          chunk.project ?? null,
          chunk.repository ?? null,
          chunk.tags ?? [],
          JSON.stringify(chunk.metadata ?? {}),
          toVectorLiteral(chunk.embedding),
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type SearchOptions = {
  limit?: number;
  sourceTypes?: KnowledgeSourceType[];
};

/** Semantic search over stored chunks via cosine similarity (pgvector HNSW index). */
export async function searchKnowledgeChunks(
  queryEmbedding: number[],
  options: SearchOptions = {},
): Promise<RetrievedChunk[]> {
  const pool = getPool();
  const limit = options.limit ?? 8;

  const params: unknown[] = [toVectorLiteral(queryEmbedding)];
  let sourceTypeFilter = "";
  if (options.sourceTypes?.length) {
    params.push(options.sourceTypes);
    sourceTypeFilter = `AND s.source_type = ANY($${params.length})`;
  }
  params.push(limit);

  const { rows } = await pool.query<{
    id: string;
    source_id: string;
    content: string;
    source_type: KnowledgeSourceType;
    source_name: string;
    project: string | null;
    repository: string | null;
    tags: string[];
    metadata: Record<string, unknown>;
    distance: number;
  }>(
    `SELECT c.id, c.source_id, c.content, s.source_type, s.source_name,
            c.project, c.repository, c.tags, c.metadata,
            c.embedding <=> $1::vector AS distance
     FROM knowledge_chunks c
     JOIN knowledge_sources s ON s.id = c.source_id
     WHERE true ${sourceTypeFilter}
     ORDER BY distance ASC
     LIMIT $${params.length}`,
    params,
  );

  return rows.map((row) => ({
    id: row.id,
    sourceId: row.source_id,
    content: row.content,
    sourceType: row.source_type,
    sourceName: row.source_name,
    project: row.project ?? undefined,
    repository: row.repository ?? undefined,
    tags: row.tags,
    metadata: row.metadata,
    embedding: [], // not returned by default; callers doing retrieval don't need it back
    score: 1 - row.distance, // cosine distance -> similarity
  }));
}

/** Escapes regex metacharacters so a keyword is matched literally, not interpreted as a pattern. */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Case-insensitive, whole-word substring search over chunk content —
 * complements semantic search for short bare terms (e.g. "Rust", "React")
 * that carry too little text for embedding similarity to score reliably,
 * but that a simple literal match finds trivially. Uses Postgres's \m/\M
 * word-boundary regex anchors so "Rust" doesn't match inside "trust".
 */
export async function keywordSearchKnowledgeChunks(
  keyword: string,
  options: SearchOptions = {},
): Promise<{ sourceName: string }[]> {
  const trimmed = keyword.trim();
  if (!trimmed) return [];

  const pool = getPool();
  const params: unknown[] = [`\\m${escapeRegex(trimmed)}\\M`];
  let sourceTypeFilter = "";
  if (options.sourceTypes?.length) {
    params.push(options.sourceTypes);
    sourceTypeFilter = `AND s.source_type = ANY($${params.length})`;
  }

  const { rows } = await pool.query<{ source_name: string }>(
    `SELECT DISTINCT s.source_name
     FROM knowledge_chunks c
     JOIN knowledge_sources s ON s.id = c.source_id
     WHERE c.content ~* $1 ${sourceTypeFilter}`,
    params,
  );

  return rows.map((row) => ({ sourceName: row.source_name }));
}

export async function listKnowledgeSources(): Promise<KnowledgeSource[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string;
    source_type: KnowledgeSourceType;
    source_name: string;
    original_filename: string | null;
    mime_type: string | null;
    raw_text: string;
    metadata: Record<string, unknown>;
    created_at: string;
  }>(
    `SELECT id, source_type, source_name, original_filename, mime_type, raw_text, metadata, created_at
     FROM knowledge_sources ORDER BY created_at DESC`,
  );

  return rows.map((row) => ({
    id: row.id,
    sourceType: row.source_type,
    sourceName: row.source_name,
    originalFilename: row.original_filename ?? undefined,
    mimeType: row.mime_type ?? undefined,
    rawText: row.raw_text,
    metadata: row.metadata,
    createdAt: row.created_at,
  }));
}

export async function deleteKnowledgeSource(sourceId: string): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM knowledge_sources WHERE id = $1`, [sourceId]);
}
