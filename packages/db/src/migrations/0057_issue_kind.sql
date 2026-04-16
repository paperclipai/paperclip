ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'task' NOT NULL;
CREATE INDEX IF NOT EXISTS "issues_company_kind_idx" ON "issues" ("company_id", "kind");
