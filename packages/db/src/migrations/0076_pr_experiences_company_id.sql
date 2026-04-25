-- Add company_id to pr_experiences and pr_outcomes for multi-tenant isolation
-- This is a supplemental migration to 0075_phase3_experience_layer

ALTER TABLE "pr_experiences" ADD COLUMN IF NOT EXISTS "company_id" uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';
ALTER TABLE "pr_outcomes" ADD COLUMN IF NOT EXISTS "company_id" uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

CREATE INDEX IF NOT EXISTS "pr_experiences_company_id_idx" ON "pr_experiences" ("company_id");
CREATE INDEX IF NOT EXISTS "pr_outcomes_company_id_idx" ON "pr_outcomes" ("company_id");
