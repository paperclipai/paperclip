-- Migration 0083: enable pgvector on knowledge_chunks and agent_memory_entries.
--
-- Mirrors 0065's defensive pattern. Each block tries the pgvector
-- operation and silently no-ops with a NOTICE if pgvector isn't installed.
-- On postgres images without pgvector (e.g., embedded test DB), this
-- migration produces no schema change.
--
-- After upgrading to pgvector/pgvector:pg17:
--   * knowledge_chunks.embedding text -> vector(768)
--   * agent_memory_entries.embedding restored as vector(1536) if it was
--     dropped during a prior pgvector reset
--   * IVFFlat cosine indexes built (ready for top-K lookup)

DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector extension not available, skipping migration 0083';
  RETURN;
END $$;

-- Upgrade knowledge_chunks.embedding text -> vector(768)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'knowledge_chunks'
      AND column_name = 'embedding'
      AND data_type = 'text'
  ) THEN
    ALTER TABLE knowledge_chunks DROP COLUMN embedding;
    ALTER TABLE knowledge_chunks ADD COLUMN embedding vector(768);
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not upgrade knowledge_chunks.embedding: %', SQLERRM;
END $$;

-- Restore agent_memory_entries.embedding to vector(1536):
--   - If column missing entirely (CASCADE-dropped during pgvector reset), add it
--   - If column exists as text (added by 0084 fallback when pgvector was missing),
--     drop it and re-add as vector
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agent_memory_entries' AND column_name = 'embedding'
  ) THEN
    ALTER TABLE agent_memory_entries ADD COLUMN embedding vector(1536);
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agent_memory_entries'
      AND column_name = 'embedding'
      AND data_type = 'text'
  ) THEN
    ALTER TABLE agent_memory_entries DROP COLUMN embedding;
    ALTER TABLE agent_memory_entries ADD COLUMN embedding vector(1536);
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not restore agent_memory_entries.embedding: %', SQLERRM;
END $$;

-- IVFFlat cosine indexes for top-K lookup
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_ivfflat_idx
    ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not create knowledge_chunks vector index';
END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS agent_memory_entries_embedding_ivfflat_idx
    ON agent_memory_entries USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not create agent_memory_entries vector index';
END $$;
