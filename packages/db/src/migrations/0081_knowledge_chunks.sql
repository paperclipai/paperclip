-- Migration 0081: knowledge_chunks table for RAG over playbooks.
--
-- Enables agents to query playbook sections by semantic similarity
-- (cosine over pgvector embeddings) or text match (Postgres FTS)
-- instead of loading full playbook bodies on every prompt.
--
-- Defensive about pgvector availability (mirrors 0065's pattern):
-- - Production runs pgvector/pgvector:pg17 -> embedding is vector(768)
-- - Embedded postgres in tests lacks pgvector -> embedding is text
-- - Migration 0083 upgrades text->vector(768) when pgvector becomes available
--
-- Embedding model: nomic-embed-text (768 dims, local Ollama).

DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector extension not available, knowledge_chunks.embedding will be text until 0083 runs on a pgvector image';
END $$;

-- Create the table with text embedding (works regardless of pgvector).
-- 0083 upgrades the column to vector(768) when pgvector is available.
CREATE TABLE IF NOT EXISTS "knowledge_chunks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "page_id" uuid NOT NULL REFERENCES "knowledge_pages"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "department" text,
  "owner_role" text,
  "audience" text,
  "document_type" text,
  "anchor" text NOT NULL,
  "heading" text NOT NULL,
  "heading_path" text NOT NULL,
  "body" text NOT NULL,
  "token_count" integer NOT NULL,
  "order_num" integer NOT NULL,
  "embedding" text,
  "source_revision" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "knowledge_chunks_page_idx"
  ON "knowledge_chunks" ("page_id");

CREATE INDEX IF NOT EXISTS "knowledge_chunks_company_dept_idx"
  ON "knowledge_chunks" ("company_id", "department");

CREATE INDEX IF NOT EXISTS "knowledge_chunks_company_doc_type_idx"
  ON "knowledge_chunks" ("company_id", "document_type");

-- FTS index works regardless of pgvector availability
CREATE INDEX IF NOT EXISTS "knowledge_chunks_fts_idx"
  ON "knowledge_chunks"
  USING gin (to_tsvector('english', heading_path || ' ' || body));
