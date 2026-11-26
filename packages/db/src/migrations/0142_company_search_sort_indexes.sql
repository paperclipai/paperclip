CREATE INDEX IF NOT EXISTS "issues_company_updated_idx" ON "issues" ("company_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_created_idx" ON "issues" ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_priority_idx" ON "issues" ("company_id","priority");
