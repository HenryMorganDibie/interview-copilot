CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT NOT NULL CHECK (source_type IN ('cv', 'github', 'project', 'document', 'job_description')),
  source_name TEXT NOT NULL,
  original_filename TEXT,
  mime_type TEXT,
  raw_text TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  -- Stable identity for a source that has one (e.g. "github:owner/repo",
  -- "cv:my-resume.pdf") so re-ingesting the same thing replaces it instead
  -- of piling up duplicate rows that retrieval then has to sift through.
  -- NULL for sources with no natural stable key -- a NULL never conflicts
  -- with another NULL, so those always insert as new rows.
  source_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Safe to re-run against an existing database (e.g. after pulling this
-- change) -- ADD COLUMN IF NOT EXISTS is a no-op if the CREATE TABLE above
-- already provided it on a fresh install.
ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS source_key TEXT UNIQUE;

-- One-time backfill so sources ingested before source_key existed still
-- get real dedup behavior on their next re-ingest, not just newly-created
-- ones. Only backfills the most recently created row per (source_type,
-- lower(source_name)) group -- if pre-existing duplicate rows already
-- exist from before this fix (exactly the bug this column fixes going
-- forward), backfilling every one of them would collide on the UNIQUE
-- constraint; older duplicates are left with a NULL key (never conflicts,
-- harmless) rather than failing this migration. No-op once already run.
UPDATE knowledge_sources s
SET source_key = s.source_type || ':' || lower(s.source_name)
WHERE s.source_key IS NULL
  AND s.id = (
    SELECT id FROM knowledge_sources s2
    WHERE s2.source_type = s.source_type AND lower(s2.source_name) = lower(s.source_name)
    ORDER BY created_at DESC LIMIT 1
  );

-- 384 dims matches all-MiniLM-L6-v2 / Xenova/all-MiniLM-L6-v2 (local, free,
-- no API key), the default embedding model — see packages/knowledge.
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  project TEXT,
  repository TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  embedding vector(384) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS knowledge_chunks_source_id_idx ON knowledge_chunks (source_id);
CREATE INDEX IF NOT EXISTS knowledge_chunks_tags_idx ON knowledge_chunks USING gin (tags);

-- Full-text search signal for hybrid retrieval (packages/knowledge/src/
-- retrieve.ts fuses this with cosine similarity via Reciprocal Rank
-- Fusion). Postgres's ts_rank_cd isn't true BM25, but it's the standard
-- practical stand-in when there's no dedicated search engine, and it's
-- exactly the failure mode semantic-only retrieval misses: a short,
-- specific term (a project name, an acronym) that embedding similarity
-- scores weakly because there's too little surrounding context to place
-- it, but that a literal text match finds immediately. GENERATED STORED so
-- it's precomputed at write time, not recalculated on every search.
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX IF NOT EXISTS knowledge_chunks_content_tsv_idx
  ON knowledge_chunks USING gin (content_tsv);
