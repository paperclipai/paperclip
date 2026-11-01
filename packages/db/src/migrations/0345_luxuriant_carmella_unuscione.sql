-- Keep both JSON branches indexable without blocking run writes during the build.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "heartbeat_runs_company_ctx_paperclip_issue_created_idx" ON "heartbeat_runs" USING btree ("company_id",("context_snapshot" -> 'paperclipIssue' ->> 'id'),"created_at" DESC NULLS LAST);--> statement-breakpoint
-- Match the creation-source query's exact native/legacy precedence.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "heartbeat_runs_company_origin_issue_idx" ON "heartbeat_runs" USING btree ("company_id",coalesce(
        "native_issue_id"::text,
        nullif("context_snapshot"->>'issueId', ''),
        nullif("context_snapshot"->>'taskId', ''),
        nullif("context_snapshot"->>'taskKey', '')
      ));
