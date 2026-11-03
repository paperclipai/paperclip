-- latestRecoveryActionRun filters runs by context_snapshot ->> 'recoveryActionId'; index it without blocking run writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "heartbeat_runs_company_ctx_recovery_action_created_idx" ON "heartbeat_runs" USING btree ("company_id",("context_snapshot" ->> 'recoveryActionId'),"created_at" DESC NULLS LAST);
