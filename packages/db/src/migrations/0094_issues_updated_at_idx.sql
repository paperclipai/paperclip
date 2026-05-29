CREATE INDEX CONCURRENTLY IF NOT EXISTS "issues_company_updated_at_idx" ON "issues" ("company_id","updated_at");
