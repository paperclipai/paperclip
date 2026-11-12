ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "default_decision_owner_user_id" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "budget_owner_user_id" text;--> statement-breakpoint
ALTER TABLE "inbox_dismissals" ADD COLUMN IF NOT EXISTS "fingerprint" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "decision_owner_user_id" text;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "activity_log_company_handled_for_created_idx" ON "activity_log" USING btree ("company_id",("details" ->> 'handledForUserId'),"created_at") WHERE ("activity_log"."details" ->> 'handledForUserId') IS NOT NULL;