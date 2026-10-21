CREATE INDEX IF NOT EXISTS "issue_recovery_actions_retained_workspace_recovery_idx" ON "issue_recovery_actions" USING btree ("id") WHERE
      ("issue_recovery_actions"."evidence"->'workspaceRestoreRecovery'->>'schema' = 'paperclip.workspace-restore-recovery.v1'
        or "issue_recovery_actions"."cause" in ('native_workspace_sync_out_unrecoverable', 'native_workspace_sync_out_retry_exhausted'))
      and ("issue_recovery_actions"."evidence"->'executionReconciliation' is null
        or "issue_recovery_actions"."evidence"#>>'{workspaceRecovery,status}' = 'recovered')
    ;
