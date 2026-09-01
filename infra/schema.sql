CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT NOT NULL CHECK (source_type IN ('cv', 'github', 'project', 'document', 'job_description')),
  source_name TEXT NOT NULL,
  original_filename TEXT,
  mime_type TEXT,
  raw_text TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
