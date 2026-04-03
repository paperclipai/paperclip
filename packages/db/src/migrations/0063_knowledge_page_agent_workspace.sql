-- Agent Library Workspace: extend knowledge_pages for agent-scoped documents.

-- Link a knowledge page to the agent whose workspace it belongs to.
ALTER TABLE "knowledge_pages" ADD COLUMN "agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL;

-- Document classification for filtering and UI grouping.
ALTER TABLE "knowledge_pages" ADD COLUMN "document_type" text;

-- Flag system-generated vs manually created documents.
ALTER TABLE "knowledge_pages" ADD COLUMN "auto_generated" boolean NOT NULL DEFAULT false;

-- Department scope for department-level knowledge.
ALTER TABLE "knowledge_pages" ADD COLUMN "department" text;

-- Index for agent workspace queries.
CREATE INDEX IF NOT EXISTS "knowledge_pages_agent_id_idx" ON "knowledge_pages" ("agent_id");

-- Index for document type filtering.
CREATE INDEX IF NOT EXISTS "knowledge_pages_company_document_type_idx" ON "knowledge_pages" ("company_id", "document_type");
