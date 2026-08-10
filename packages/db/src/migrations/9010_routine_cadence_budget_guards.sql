ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "routine_guard_config" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routine_runs_company_routine_triggered_idx" ON "routine_runs" USING btree ("company_id", "routine_id", "triggered_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_events_issue_occurred_idx" ON "cost_events" USING btree ("issue_id", "occurred_at") WHERE "issue_id" IS NOT NULL;
