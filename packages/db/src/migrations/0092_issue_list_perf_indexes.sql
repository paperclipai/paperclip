-- Note: CREATE INDEX CONCURRENTLY cannot run inside a transaction.
-- Drizzle's migration runner wraps each migration in a transaction, so CONCURRENTLY
-- is not used here. The IF NOT EXISTS guard makes this safe to re-run. On large
-- tables this will hold a SHARE lock for 30-120 seconds; run during low-traffic if possible.
CREATE INDEX IF NOT EXISTS "issues_company_unhidden_updated_idx" ON "issues" ("company_id","updated_at" DESC) WHERE "hidden_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_created_by_user_idx" ON "issues" ("company_id","created_by_user_id") WHERE "created_by_user_id" IS NOT NULL;