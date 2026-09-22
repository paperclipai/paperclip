-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run
-- transactionally, so CONCURRENTLY is unavailable here. This expression index covers the second
-- branch of the OR in run-secret-redaction valuesForIssue. Without it the planner cannot BitmapOr
-- that OR, and every issue read falls back to a sequential scan that detoasts context_snapshot in
-- every row. The one-time build lock is the lesser cost. heartbeat_runs is in the medium size
-- bucket today, so this rule does not fire, but the lock is taken knowingly.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_ctx_paperclip_issue_created_idx" ON "heartbeat_runs" USING btree ("company_id",("context_snapshot" -> 'paperclipIssue' ->> 'id'),"created_at" DESC NULLS LAST);