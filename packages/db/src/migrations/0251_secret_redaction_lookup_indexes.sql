-- The application uses a transactional migrator, so these partial indexes
-- intentionally use CREATE INDEX rather than CREATE INDEX CONCURRENTLY.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: partial indexes bound the secret-redaction lookup to the small subset of heartbeat runs that can contain registered material
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_redaction_issue_idx"
  ON "heartbeat_runs" USING btree (
    "company_id",
    ("context_snapshot" ->> 'issueId')
  )
  WHERE "heartbeat_runs"."context_snapshot" ? 'paperclipSecretRedactions';
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: partial indexes bound the secret-redaction lookup to the small subset of heartbeat runs that can contain registered material
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_redaction_nested_issue_idx"
  ON "heartbeat_runs" USING btree (
    "company_id",
    ("context_snapshot" -> 'paperclipIssue' ->> 'id')
  )
  WHERE "heartbeat_runs"."context_snapshot" ? 'paperclipSecretRedactions';
