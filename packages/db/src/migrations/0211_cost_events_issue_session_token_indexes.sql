CREATE INDEX IF NOT EXISTS "cost_events_company_issue_idx" ON "cost_events" USING btree ("company_id", "issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "session_token_uq" ON "session" USING btree ("token");
