CREATE INDEX CONCURRENTLY IF NOT EXISTS "heartbeat_runs_company_native_workspace_idx" ON "heartbeat_runs" USING btree ("company_id",("runner_profile_json"->'nativeWorkspaceSync'->>'workspaceId'));
