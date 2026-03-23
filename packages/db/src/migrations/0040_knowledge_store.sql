-- Unified Knowledge Store: single source of truth for all agent memory
-- All 380 agents across all platforms write/read from this table

CREATE TABLE IF NOT EXISTS "knowledge_store" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid REFERENCES "companies"("id"),
  "source_agent_id" uuid REFERENCES "agents"("id"),
  "source_platform" text NOT NULL DEFAULT 'claude_local',
  "category" text NOT NULL DEFAULT 'observation',
  "title" text NOT NULL,
  "body" text NOT NULL,
  "tags" text[] NOT NULL DEFAULT '{}',
  "project_id" uuid REFERENCES "projects"("id"),
  "relevance_score" real NOT NULL DEFAULT 1.0,
  "access_count" integer NOT NULL DEFAULT 0,
  "superseded_by" uuid REFERENCES "knowledge_store"("id"),
  "ttl_days" integer,
  "search_vector" tsvector,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- Trigger to auto-update search_vector on insert/update
CREATE OR REPLACE FUNCTION knowledge_store_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.body, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(array_to_string(NEW.tags, ' '), '')), 'A');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER knowledge_store_search_vector_trigger
  BEFORE INSERT OR UPDATE ON "knowledge_store"
  FOR EACH ROW EXECUTE FUNCTION knowledge_store_search_vector_update();

CREATE INDEX IF NOT EXISTS "knowledge_store_company_category_idx" ON "knowledge_store" ("company_id", "category");
CREATE INDEX IF NOT EXISTS "knowledge_store_tags_idx" ON "knowledge_store" USING gin ("tags");
CREATE INDEX IF NOT EXISTS "knowledge_store_source_agent_idx" ON "knowledge_store" ("source_agent_id");
CREATE INDEX IF NOT EXISTS "knowledge_store_relevance_idx" ON "knowledge_store" ("relevance_score" DESC);
CREATE INDEX IF NOT EXISTS "knowledge_store_search_idx" ON "knowledge_store" USING gin ("search_vector");
CREATE INDEX IF NOT EXISTS "knowledge_store_project_idx" ON "knowledge_store" ("project_id");
CREATE INDEX IF NOT EXISTS "knowledge_store_created_idx" ON "knowledge_store" ("created_at" DESC);

-- Agent capability columns for holding-wide discovery
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "capability_tags" text[] NOT NULL DEFAULT '{}';
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "specialty" text;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "current_task_summary" text;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "availability" text NOT NULL DEFAULT 'available';

CREATE INDEX IF NOT EXISTS "agents_capability_tags_idx" ON "agents" USING gin ("capability_tags");
CREATE INDEX IF NOT EXISTS "agents_availability_idx" ON "agents" ("company_id", "availability");

-- Workflow type for meetings/consensus
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "workflow_type" text NOT NULL DEFAULT 'pipeline';

-- Cross-company issue delegation
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "delegated_from_company_id" uuid REFERENCES "companies"("id");
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "delegated_from_issue_id" uuid REFERENCES "issues"("id");
