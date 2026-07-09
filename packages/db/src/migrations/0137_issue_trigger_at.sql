ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "trigger_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_trigger_at_idx" ON "issues" USING btree ("company_id","trigger_at") WHERE "trigger_at" IS NOT NULL;
