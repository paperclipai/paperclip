CREATE INDEX CONCURRENTLY IF NOT EXISTS "heartbeat_runs_cancelled_workspace_preservation_idx" ON "heartbeat_runs" USING btree ("id","company_id") WHERE "heartbeat_runs"."runtime_mode" = 'native' AND "heartbeat_runs"."status" = 'cancelled'
        AND "heartbeat_runs"."runner_profile_json"->'nativeWorkspaceSync'->>'state' = 'prepared'
        AND "heartbeat_runs"."result_json"->'nativeCancellation'->>'dispatchState' = 'acknowledged'
        AND ("heartbeat_runs"."result_json"->'workspaceRestoreRecovery'->>'schema' = 'paperclip.workspace-restore-recovery.v1'
          AND "heartbeat_runs"."result_json"->>'workspaceRestoreFailure' IN ('restore_permission_denied', 'restore_lock_timeout', 'restore_unsafe_archive', 'restore_failed')) IS NOT TRUE;