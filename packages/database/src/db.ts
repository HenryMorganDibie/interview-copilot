import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

let db: DatabaseSync | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS knowledge_sources (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('cv','github','project','document','job_description')),
  source_name TEXT NOT NULL,
  original_filename TEXT,
  mime_type TEXT,
  raw_text TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  source_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  project TEXT,
  repository TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  embedding TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS knowledge_chunks_source_id_idx ON knowledge_chunks(source_id);

-- Standalone (not external-content) FTS5 table, kept in sync manually in
-- knowledgeRepository.ts rather than via triggers -- simpler to reason
-- about for a dataset this small, and avoids SQLite's external-content
-- rowid-aliasing requirements entirely.
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(chunk_id UNINDEXED, content);
`;

/**
 * Lazily opens the local SQLite database (Node's built-in node:sqlite --
 * no native module, no separate server process, ships with Node itself).
 * Replaces Postgres/pgvector: this app's real dataset (a handful of CVs
 * and GitHub repos, low hundreds of chunks at most) is far below the
 * scale where an approximate-nearest-neighbor index earns its complexity
 * -- a linear-scan cosine similarity in JS (see knowledgeRepository.ts) is
 * sub-millisecond here, and FTS5 covers the full-text half of hybrid
 * retrieval that previously used Postgres's tsvector/ts_rank_cd. This is
 * what makes the app installable with zero external dependencies (no
 * Docker, no Postgres, nothing to start) -- the database is just a file.
 */
export function getDb(): DatabaseSync {
  if (!db) {
    const dbPath = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "interview-copilot.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA);
  }
  return db;
}
