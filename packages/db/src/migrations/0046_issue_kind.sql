ALTER TABLE "issues" ADD COLUMN "kind" text DEFAULT 'task' NOT NULL;
CREATE INDEX "issues_company_kind_idx" ON "issues" ("company_id", "kind");
