-- Phase K.1: Knowledge OS foundation
-- Tables: knowledge_topics, knowledge_sources, knowledge_chunks, knowledge_crawl_runs
-- Self-hosted Firecrawl on R620, hybrid BM25 + vector retrieval

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- =============================================================================
-- Knowledge Topics
-- =============================================================================
CREATE TABLE "knowledge_topics" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL UNIQUE,
  "slug" text NOT NULL UNIQUE,
  "description" text,
  "tier" integer NOT NULL DEFAULT 1,
  "status" text NOT NULL DEFAULT 'active',
  "refresh_interval_hours" integer NOT NULL DEFAULT 48,
  "last_crawled_at" timestamptz,
  "next_crawl_at" timestamptz,
  "chunk_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX "knowledge_topics_slug_idx" ON "knowledge_topics" ("slug");
CREATE INDEX "knowledge_topics_tier_idx" ON "knowledge_topics" ("tier");
CREATE INDEX "knowledge_topics_status_idx" ON "knowledge_topics" ("status");

-- =============================================================================
-- Knowledge Sources
-- =============================================================================
CREATE TABLE "knowledge_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "topic_id" uuid NOT NULL REFERENCES "knowledge_topics"("id") ON DELETE CASCADE,
  "url" text NOT NULL,
  "source_type" text NOT NULL DEFAULT 'documentation',
  "title" text,
  "robots_allowed" boolean NOT NULL DEFAULT true,
  "rate_limit_respect" boolean NOT NULL DEFAULT true,
  "crawl_frequency_hours" integer NOT NULL DEFAULT 168,
  "last_crawled_at" timestamptz,
  "last_scraped_at" timestamptz,
  "last_error" text,
  "page_count" integer NOT NULL DEFAULT 0,
  "is_allowed" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX "knowledge_sources_topic_id_idx" ON "knowledge_sources" ("topic_id");
CREATE INDEX "knowledge_sources_url_idx" ON "knowledge_sources" ("url");
CREATE INDEX "knowledge_sources_is_allowed_idx" ON "knowledge_sources" ("is_allowed");

-- =============================================================================
-- Knowledge Chunks (with vector embedding)
-- =============================================================================
CREATE TABLE "knowledge_chunks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_id" uuid NOT NULL REFERENCES "knowledge_sources"("id") ON DELETE CASCADE,
  "topic_id" uuid NOT NULL REFERENCES "knowledge_topics"("id") ON DELETE CASCADE,
  "url" text NOT NULL,
  "url_path" text NOT NULL,
  "title" text NOT NULL,
  "content" text NOT NULL,
  "content_hash" text NOT NULL UNIQUE,
  "embedding" text NOT NULL,
  "bm25_score" text,
  "chunk_index" integer NOT NULL DEFAULT 0,
  "token_estimate" integer NOT NULL DEFAULT 0,
  "heading" text,
  "section" text,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX "knowledge_chunks_source_id_idx" ON "knowledge_chunks" ("source_id");
CREATE INDEX "knowledge_chunks_topic_id_idx" ON "knowledge_chunks" ("topic_id");
CREATE INDEX "knowledge_chunks_content_hash_idx" ON "knowledge_chunks" ("content_hash");
CREATE INDEX "knowledge_chunks_url_path_idx" ON "knowledge_chunks" ("url_path");
CREATE INDEX "knowledge_chunks_token_estimate_idx" ON "knowledge_chunks" ("token_estimate");

-- =============================================================================
-- Knowledge Crawl Runs
-- =============================================================================
CREATE TABLE "knowledge_crawl_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_id" uuid NOT NULL REFERENCES "knowledge_sources"("id") ON DELETE CASCADE,
  "topic_id" uuid NOT NULL REFERENCES "knowledge_topics"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'running',
  "started_at" timestamptz NOT NULL DEFAULT NOW(),
  "completed_at" timestamptz,
  "pages_discovered" integer NOT NULL DEFAULT 0,
  "pages_crawled" integer NOT NULL DEFAULT 0,
  "pages_indexed" integer NOT NULL DEFAULT 0,
  "chunks_created" integer NOT NULL DEFAULT 0,
  "error_message" text,
  "error_code" text,
  "crawler_version" text,
  "user_agent" text,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX "knowledge_crawl_runs_source_id_idx" ON "knowledge_crawl_runs" ("source_id");
CREATE INDEX "knowledge_crawl_runs_topic_id_idx" ON "knowledge_crawl_runs" ("topic_id");
CREATE INDEX "knowledge_crawl_runs_status_idx" ON "knowledge_crawl_runs" ("status");
CREATE INDEX "knowledge_crawl_runs_started_at_idx" ON "knowledge_crawl_runs" ("started_at");

-- =============================================================================
-- Seed 10 tier-1 topics
-- =============================================================================
INSERT INTO "knowledge_topics" ("name", "slug", "description", "tier", "status", "refresh_interval_hours") VALUES
  ('Clerk', 'clerk', 'Authentication and user management via Clerk', 1, 'active', 72),
  ('Stripe', 'stripe', 'Payments and billing via Stripe', 1, 'active', 72),
  ('Next.js', 'nextjs', 'React framework for production', 1, 'active', 168),
  ('Drizzle', 'drizzle', 'TypeScript ORM for Postgres', 1, 'active', 168),
  ('Tailwind', 'tailwind', 'Utility-first CSS framework', 1, 'active', 168),
  ('Radix', 'radix', 'Unstyled, accessible UI components', 1, 'active', 168),
  ('Postgres', 'postgres', 'Advanced open source database', 1, 'active', 168),
  ('TypeScript', 'typescript', 'JavaScript with syntax for types', 1, 'active', 168),
  ('Playwright', 'playwright', 'End-to-end testing for web apps', 1, 'active', 168),
  ('Dokploy', 'dokploy', 'Self-hosting platform for web apps', 1, 'active', 72)
ON CONFLICT ("slug") DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  tier = EXCLUDED.tier,
  status = EXCLUDED.status,
  refresh_interval_hours = EXCLUDED.refresh_interval_hours,
  updated_at = NOW();

-- =============================================================================
-- Updated_at trigger
-- =============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updated_at" = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_knowledge_topics_updated_at
  BEFORE UPDATE ON "knowledge_topics"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_knowledge_sources_updated_at
  BEFORE UPDATE ON "knowledge_sources"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_knowledge_chunks_updated_at
  BEFORE UPDATE ON "knowledge_chunks"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_knowledge_crawl_runs_updated_at
  BEFORE UPDATE ON "knowledge_crawl_runs"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();