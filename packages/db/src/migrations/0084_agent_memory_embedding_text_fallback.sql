-- Migration 0084: ensure agent_memory_entries.embedding column ALWAYS exists.
--
-- Migration 0065 attempts to add `embedding vector(1536)` but silently
-- skips if pgvector is unavailable (embedded postgres in tests, or hosts
-- without the .so). The application code (agent-memory.ts) references
-- the column unconditionally. When the column doesn't exist, queries
-- like `${embedding} IS NOT NULL` throw "column does not exist".
--
-- Fix: if migration 0065 didn't add the column (pgvector missing at
-- that time), add it as `text`. Embeddings stored as text are inert
-- but the column shape lets queries succeed (always returns NULL).
--
-- When pgvector becomes available later, migration 0083's logic
-- handles the text -> vector(1536) upgrade.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agent_memory_entries' AND column_name = 'embedding'
  ) THEN
    ALTER TABLE agent_memory_entries ADD COLUMN embedding text;
    RAISE NOTICE 'Added agent_memory_entries.embedding as text (pgvector unavailable)';
  END IF;
END $$;
