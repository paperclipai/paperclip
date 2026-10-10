ALTER TABLE "company_skill_test_runs" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_skill_test_runs" ADD COLUMN IF NOT EXISTS "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_skill_test_runs" ADD COLUMN IF NOT EXISTS "harness_issue_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_skill_test_runs" ADD COLUMN IF NOT EXISTS "harness_issue_deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_skill_test_runs_company_harness_expires_idx" ON "company_skill_test_runs" USING btree ("company_id","harness_issue_expires_at");
