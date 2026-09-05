import type { KnowledgeSource, KnowledgeSourceType, RetrievedChunk } from "@interview-copilot/shared";
import { getPool } from "./pool.js";

type InsertSourceInput = {
  sourceType: KnowledgeSourceType;
  sourceName: string;
  originalFilename?: string;
  mimeType?: string;
  rawText: string;
  metadata?: Record<string, unknown>;
  /**
   * Stable identity for sources that have one (e.g. "github:owner/repo",
   * "cv:my-resume.pdf") -- re-ingesting with the same key replaces the
   * existing source and its chunks instead of creating a duplicate row.
   * Omit for sources with no natural stable key; each such call inserts a
   * new row (NULL never conflicts with another NULL).
   */
  sourceKey?: string;
};

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

/**
 * Upserts a source and (re)writes its chunks in a single transaction. Chunks
 * must already be parsed/embedded before calling this -- nothing here talks
 * to an external service, so a failure anywhere upstream (parsing,
 * embedding) never reaches Postgres at all, and a failure here rolls back
 * atomically instead of leaving a source row with no chunks (or, on
 * re-ingest, half-replaced chunks).
 */
export async function upsertKnowledgeSourceWithChunks(
  source: InsertSourceInput,
  chunks: Omit<InsertChunkInput, "sourceId">[],
): Promise<KnowledgeSource & { chunkCount: number }> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows } = await client.query<{
      id: string;
      source_type: KnowledgeSourceType;
      source_name: string;
      original_filename: string | null;
      mime_type: string | null;
      raw_text: string;
      metadata: Record<string, unknown>;
      created_at: string;
    }>(
      `INSERT INTO knowledge_sources (source_type, source_name, original_filename, mime_type, raw_text, metadata, source_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (source_key) DO UPDATE SET
         source_type = EXCLUDED.source_type,
         source_name = EXCLUDED.source_name,
         original_filename = EXCLUDED.original_filename,
         mime_type = EXCLUDED.mime_type,
         raw_text = EXCLUDED.raw_text,
         metadata = EXCLUDED.metadata,
         created_at = now()
       RETURNING id, source_type, source_name, original_filename, mime_type, raw_text, metadata, created_at`,
      [
        source.sourceType,
        source.sourceName,
        source.originalFilename ?? null,
        source.mimeType ?? null,
        source.rawText,
        JSON.stringify(source.metadata ?? {}),
        source.sourceKey ?? null,
      ],
    );
    const row = rows[0];

    // Harmless no-op on a brand-new source; clears the previous chunk set
    // on a re-ingest (upsert) so stale chunks never linger alongside fresh
    // ones under the same source.
    await client.query(`DELETE FROM knowledge_chunks WHERE source_id = $1`, [row.id]);

    for (const chunk of chunks) {
      await client.query(
        `INSERT INTO knowledge_chunks (source_id, content, project, repository, tags, metadata, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
        [
          row.id,
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

    return {
      id: row.id,
      sourceType: row.source_type,
      sourceName: row.source_name,
      originalFilename: row.original_filename ?? undefined,
      mimeType: row.mime_type ?? undefined,
      rawText: row.raw_text,
      metadata: row.metadata,
      createdAt: row.created_at,
      chunkCount: chunks.length,
    };
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

/**
 * Full-text search over stored chunks via Postgres's built-in text search
 * (websearch_to_tsquery + ts_rank_cd against the content_tsv generated
 * column) — the keyword/BM25-like half of hybrid retrieval. Complements
 * cosine similarity search, which is a weak signal for specific short
 * terms (project names, acronyms) that don't carry much embedding weight
 * on their own. websearch_to_tsquery tolerates arbitrary natural-language
 * input (unlike plainto_tsquery/to_tsquery, it won't throw on stray
 * punctuation) and simply matches nothing if the query has no meaningful
 * terms left after stopword removal.
 */
export async function fullTextSearchKnowledgeChunks(
  query: string,
  options: SearchOptions = {},
): Promise<RetrievedChunk[]> {
  const pool = getPool();
  const limit = options.limit ?? 8;

  const params: unknown[] = [query];
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
    rank: number;
  }>(
    `SELECT c.id, c.source_id, c.content, s.source_type, s.source_name,
            c.project, c.repository, c.tags, c.metadata,
            ts_rank_cd(c.content_tsv, websearch_to_tsquery('english', $1)) AS rank
     FROM knowledge_chunks c
     JOIN knowledge_sources s ON s.id = c.source_id
     WHERE c.content_tsv @@ websearch_to_tsquery('english', $1) ${sourceTypeFilter}
     ORDER BY rank DESC
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
    embedding: [],
    score: row.rank,
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
