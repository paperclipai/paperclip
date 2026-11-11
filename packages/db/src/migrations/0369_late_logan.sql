CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "agent_wakeup_requests_task_retry_idempotency_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'task-retry:%';--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "environment_leases_retained_recovery_adoption_idx" ON "environment_leases" USING btree ("heartbeat_run_id") WHERE "environment_leases"."lease_policy" = 'retain_on_failure'
        and "environment_leases"."heartbeat_run_id" is not null
        and not (coalesce("environment_leases"."metadata", '{}'::jsonb) ? 'systemRecoveryAdoption');--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "heartbeat_runs_retained_recovery_adoption_idx" ON "heartbeat_runs" USING btree ("id") WHERE "heartbeat_runs"."result_json"->'workspaceRestoreRecovery'->>'schema' = 'paperclip.workspace-restore-recovery.v1'
        and not (coalesce("heartbeat_runs"."result_json", '{}'::jsonb) ? 'systemRecoveryAdoption')
        and "heartbeat_runs"."status" in ('failed', 'interrupted', 'timed_out', 'cancelled', 'succeeded');--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_recovery_actions_source_run_idx" ON "issue_recovery_actions" USING btree ("company_id","source_issue_id",("evidence"->>'runId'));--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_recovery_actions_system_recovery_due_idx" ON "issue_recovery_actions" USING btree (("evidence"#>'{systemRecovery,nextAttemptAt}'),"id") WHERE "issue_recovery_actions"."evidence" ? 'systemRecovery';--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_recovery_actions_system_recovery_adoption_idx" ON "issue_recovery_actions" USING btree ("id") WHERE not ("issue_recovery_actions"."evidence" ? 'systemRecovery') and (
        "issue_recovery_actions"."evidence"->'workspaceRestoreRecovery'->>'schema' = 'paperclip.workspace-restore-recovery.v1'
        or "issue_recovery_actions"."cause" in ('native_workspace_sync_out_unrecoverable', 'native_workspace_sync_out_retry_exhausted')
      );
