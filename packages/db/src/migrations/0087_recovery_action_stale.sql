ALTER TABLE "issue_recovery_actions" ADD COLUMN "stale" boolean DEFAULT false NOT NULL;

CREATE INDEX IF NOT EXISTS "issue_recovery_actions_company_stale_idx" ON "issue_recovery_actions" ("company_id","stale","status");
