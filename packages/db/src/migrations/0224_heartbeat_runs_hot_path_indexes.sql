CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_created_desc_idx"
  ON "heartbeat_runs" USING btree ("company_id","created_at" DESC,"id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_issue_created_desc_idx"
  ON "heartbeat_runs" USING btree ("company_id",(("context_snapshot" ->> 'issueId')),"created_at" DESC,"id" DESC);
