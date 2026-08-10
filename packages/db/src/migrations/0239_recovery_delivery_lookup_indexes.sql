CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_recovery_action_id_idx"
  ON "heartbeat_runs" USING btree ("company_id", (("context_snapshot" ->> 'recoveryActionId')), "id")
  WHERE ("context_snapshot" ->> 'recoveryActionId') IS NOT NULL;
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable. Existing staging deployments already have this idempotent recovery-lookup index; fresh upstream-resync installs need it for recovery-action wake lookups.
CREATE INDEX IF NOT EXISTS "agent_wakeup_requests_company_recovery_action_id_idx"
  ON "agent_wakeup_requests" USING btree ("company_id", (("payload" ->> 'recoveryActionId')), "id")
  WHERE ("payload" ->> 'recoveryActionId') IS NOT NULL;
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable. Existing staging deployments already have this idempotent recovery-lookup index; fresh upstream-resync installs need it for nested recovery-action wake lookups.
CREATE INDEX IF NOT EXISTS "agent_wakeup_requests_company_nested_recovery_action_id_idx"
  ON "agent_wakeup_requests" USING btree ("company_id", (("payload" -> '_paperclipWakeContext' ->> 'recoveryActionId')), "id")
  WHERE ("payload" -> '_paperclipWakeContext' ->> 'recoveryActionId') IS NOT NULL;
