CREATE INDEX IF NOT EXISTS "cost_events_company_issue_occurred_idx" ON "cost_events" ("company_id","issue_id","occurred_at");
