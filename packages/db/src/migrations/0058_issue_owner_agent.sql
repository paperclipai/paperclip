ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "owner_agent_id" uuid REFERENCES "agents"("id");
CREATE INDEX IF NOT EXISTS "issues_company_owner_status_idx" ON "issues" ("company_id", "owner_agent_id", "status");
