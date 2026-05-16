ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "in_review_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_in_review_at_idx" ON "issues" ("company_id","in_review_at");
