import type { KnowledgeSource, KnowledgeSourceType, RetrievedChunk } from "@interview-copilot/shared";
import { getDb } from "./db.js";

type SqlParam = string | number | bigint | Uint8Array | null;

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
  content: string;
  project?: string;
  repository?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  embedding: number[];
};

type SourceRow = {
  id: string;
  source_type: KnowledgeSourceType;
  source_name: string;
  original_filename: string | null;
  mime_type: string | null;
  raw_text: string;
  metadata: string;
  created_at: string;
};

type ChunkRow = {
  id: string;
  source_id: string;
  content: string;
  source_type: KnowledgeSourceType;
  source_name: string;
  project: string | null;
  repository: string | null;
  tags: string;
  metadata: string;
  embedding: string;
};

function sourceRowToSource(row: SourceRow): KnowledgeSource {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceName: row.source_name,
    originalFilename: row.original_filename ?? undefined,
    mimeType: row.mime_type ?? undefined,
    rawText: row.raw_text,
    metadata: JSON.parse(row.metadata),
    createdAt: row.created_at,
  };
}

function chunkRowToChunk(row: ChunkRow, score: number): RetrievedChunk {
  return {
    id: row.id,
    sourceId: row.source_id,
    content: row.content,
    sourceType: row.source_type,
    sourceName: row.source_name,
    project: row.project ?? undefined,
    repository: row.repository ?? undefined,
    tags: JSON.parse(row.tags),
    metadata: JSON.parse(row.metadata),
    embedding: [],
    score,
  };
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function sourceTypeFilterClause(sourceTypes: KnowledgeSourceType[] | undefined, alias: string, params: SqlParam[]): string {
  if (!sourceTypes?.length) return "";
  params.push(...sourceTypes);
  return `AND ${alias}.source_type IN (${sourceTypes.map(() => "?").join(",")})`;
}

/**
 * Upserts a source and (re)writes its chunks (both the row store and the
 * FTS5 index) in a single transaction. Chunks must already be
 * parsed/embedded before calling this -- nothing here talks to an external
 * service, so a failure anywhere upstream (parsing, embedding) never
 * reaches the database at all, and a failure here rolls back atomically
 * instead of leaving a source row with no chunks (or, on re-ingest,
 * half-replaced chunks).
 */
export async function upsertKnowledgeSourceWithChunks(
  source: InsertSourceInput,
  chunks: InsertChunkInput[],
): Promise<KnowledgeSource & { chunkCount: number }> {
  const db = getDb();
  const now = new Date().toISOString();

  db.exec("BEGIN");
  try {
    let sourceId: string;
    const existing = source.sourceKey
      ? (db.prepare("SELECT id FROM knowledge_sources WHERE source_key = ?").get(source.sourceKey) as
          | { id: string }
          | undefined)
      : undefined;

    if (existing) {
      sourceId = existing.id;
      db.prepare(
        `UPDATE knowledge_sources
         SET source_type = ?, source_name = ?, original_filename = ?, mime_type = ?, raw_text = ?, metadata = ?, created_at = ?
         WHERE id = ?`,
      ).run(
        source.sourceType,
        source.sourceName,
        source.originalFilename ?? null,
        source.mimeType ?? null,
        source.rawText,
        JSON.stringify(source.metadata ?? {}),
        now,
        sourceId,
      );
    } else {
      sourceId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO knowledge_sources (id, source_type, source_name, original_filename, mime_type, raw_text, metadata, source_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sourceId,
        source.sourceType,
        source.sourceName,
        source.originalFilename ?? null,
        source.mimeType ?? null,
        source.rawText,
        JSON.stringify(source.metadata ?? {}),
        source.sourceKey ?? null,
        now,
      );
    }

    // Clear the previous chunk set (row store + FTS index) -- harmless
    // no-op on a brand-new source, and on a re-ingest (upsert) this is what
    // stops stale chunks from lingering alongside fresh ones.
    const oldChunkIds = (
      db.prepare("SELECT id FROM knowledge_chunks WHERE source_id = ?").all(sourceId) as { id: string }[]
    ).map((r) => r.id);
    for (const chunkId of oldChunkIds) {
      db.prepare("DELETE FROM knowledge_chunks_fts WHERE chunk_id = ?").run(chunkId);
    }
    db.prepare("DELETE FROM knowledge_chunks WHERE source_id = ?").run(sourceId);

    for (const chunk of chunks) {
      const chunkId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO knowledge_chunks (id, source_id, content, project, repository, tags, metadata, embedding, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        chunkId,
        sourceId,
        chunk.content,
        chunk.project ?? null,
        chunk.repository ?? null,
        JSON.stringify(chunk.tags ?? []),
        JSON.stringify(chunk.metadata ?? {}),
        JSON.stringify(chunk.embedding),
        now,
      );
      db.prepare("INSERT INTO knowledge_chunks_fts (chunk_id, content) VALUES (?, ?)").run(chunkId, chunk.content);
    }

    db.exec("COMMIT");

    const row = db.prepare("SELECT * FROM knowledge_sources WHERE id = ?").get(sourceId) as SourceRow;
    return { ...sourceRowToSource(row), chunkCount: chunks.length };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export type SearchOptions = {
  limit?: number;
  sourceTypes?: KnowledgeSourceType[];
};

/** Semantic search over stored chunks via cosine similarity, computed in JS. */
export async function searchKnowledgeChunks(
  queryEmbedding: number[],
  options: SearchOptions = {},
): Promise<RetrievedChunk[]> {
  const db = getDb();
  const limit = options.limit ?? 8;
  const params: SqlParam[] = [];
  const filter = sourceTypeFilterClause(options.sourceTypes, "s", params);

  const rows = db
    .prepare(
      `SELECT c.id, c.source_id, c.content, s.source_type, s.source_name, c.project, c.repository, c.tags, c.metadata, c.embedding
       FROM knowledge_chunks c
       JOIN knowledge_sources s ON s.id = c.source_id
       WHERE true ${filter}`,
    )
    .all(...params) as ChunkRow[];

  const scored = rows.map((row) => ({
    row,
    score: cosineSimilarity(queryEmbedding, JSON.parse(row.embedding)),
  }));
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(({ row, score }) => chunkRowToChunk(row, score));
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could", "should", "may",
  "might", "must", "can", "this", "that", "these", "those", "i", "you", "he", "she", "it",
  "we", "they", "what", "which", "who", "whom", "whose", "when", "where", "why", "how",
  "tell", "me", "about", "your", "my", "our", "their", "his", "her", "its", "of", "in",
  "on", "at", "to", "for", "with", "as", "by", "from",
]);

/**
 * Builds an FTS5 MATCH query from arbitrary natural-language text: strips
 * common stopwords (FTS5 has no built-in stopword removal the way
 * Postgres's 'english' text-search config does), quotes each remaining
 * term as a literal phrase token (so punctuation in the source text can't
 * be misread as FTS5 query syntax), and joins with a space -- FTS5's
 * default boolean operator for adjacent bareword/phrase tokens is AND,
 * matching the same "all meaningful terms must appear" behavior the
 * previous Postgres websearch_to_tsquery-based version had.
 */
function buildFtsQuery(text: string): string {
  const terms = (text.match(/[\p{L}\p{N}]+/gu) ?? [])
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  const unique = [...new Set(terms)];
  if (unique.length === 0) return "";
  return unique.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

/**
 * Full-text search over stored chunks via SQLite FTS5 (bm25 ranking) --
 * the keyword/BM25-like half of hybrid retrieval, complementing cosine
 * similarity search which is a weak signal for specific short terms
 * (project names, acronyms) that don't carry much embedding weight on
 * their own.
 */
export async function fullTextSearchKnowledgeChunks(
  query: string,
  options: SearchOptions = {},
): Promise<RetrievedChunk[]> {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  const db = getDb();
  const limit = options.limit ?? 8;
  const params: SqlParam[] = [ftsQuery];
  const filter = sourceTypeFilterClause(options.sourceTypes, "s", params);
  params.push(limit);

  const rows = db
    .prepare(
      `SELECT c.id, c.source_id, c.content, s.source_type, s.source_name, c.project, c.repository, c.tags, c.metadata,
              bm25(knowledge_chunks_fts) AS rank
       FROM knowledge_chunks_fts
       JOIN knowledge_chunks c ON c.id = knowledge_chunks_fts.chunk_id
       JOIN knowledge_sources s ON s.id = c.source_id
       WHERE knowledge_chunks_fts MATCH ? ${filter}
       ORDER BY rank
       LIMIT ?`,
    )
    .all(...params) as (ChunkRow & { rank: number })[];

  // bm25() returns a negative score where more negative = more relevant;
  // negate so this matches the rest of the app's "higher score = better" convention.
  return rows.map((row) => chunkRowToChunk(row, -row.rank));
}

/** Escapes regex metacharacters so a keyword is matched literally, not interpreted as a pattern. */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Case-insensitive, whole-word substring search over chunk content --
 * complements semantic search for short bare terms (e.g. "Rust", "React")
 * that carry too little text for embedding similarity to score reliably,
 * but that a simple literal match finds trivially. A plain in-JS scan
 * (not FTS5) since this dataset is tiny and the exact word-boundary
 * substring semantics (not FTS5's tokenized MATCH) are what job-matching
 * depends on.
 */
export async function keywordSearchKnowledgeChunks(
  keyword: string,
  options: SearchOptions = {},
): Promise<{ sourceName: string }[]> {
  const trimmed = keyword.trim();
  if (!trimmed) return [];

  const db = getDb();
  const params: SqlParam[] = [];
  const filter = sourceTypeFilterClause(options.sourceTypes, "s", params);
  const rows = db
    .prepare(
      `SELECT DISTINCT s.source_name, c.content
       FROM knowledge_chunks c
       JOIN knowledge_sources s ON s.id = c.source_id
       WHERE true ${filter}`,
    )
    .all(...params) as { source_name: string; content: string }[];

  const pattern = new RegExp(`\\b${escapeRegex(trimmed)}\\b`, "i");
  const matched = new Set<string>();
  for (const row of rows) {
    if (pattern.test(row.content)) matched.add(row.source_name);
  }
  return [...matched].map((sourceName) => ({ sourceName }));
}

export async function listKnowledgeSources(): Promise<KnowledgeSource[]> {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM knowledge_sources ORDER BY created_at DESC").all() as SourceRow[];
  return rows.map(sourceRowToSource);
}

export async function deleteKnowledgeSource(sourceId: string): Promise<void> {
  const db = getDb();
  db.exec("BEGIN");
  try {
    const chunkIds = (
      db.prepare("SELECT id FROM knowledge_chunks WHERE source_id = ?").all(sourceId) as { id: string }[]
    ).map((r) => r.id);
    for (const chunkId of chunkIds) {
      db.prepare("DELETE FROM knowledge_chunks_fts WHERE chunk_id = ?").run(chunkId);
    }
    db.prepare("DELETE FROM knowledge_sources WHERE id = ?").run(sourceId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
