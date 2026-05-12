CREATE INDEX IF NOT EXISTS "issues_company_status_updated_idx" ON "issues" USING btree ("company_id","status","updated_at" DESC);--> statement-breakpoint
DROP INDEX IF EXISTS "issues_company_status_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "issues_company_parent_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_hidden_priority_updated_idx" ON "issues" USING btree (
  "company_id",
  "hidden_at",
  (CASE "priority" WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END),
  "updated_at" DESC
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_parent_status_hidden_priority_updated_idx" ON "issues" USING btree (
  "company_id",
  "parent_id",
  "status",
  "hidden_at",
  (CASE "priority" WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END),
  "updated_at" DESC
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_log_company_issue_activity_idx" ON "activity_log" USING btree ("company_id","entity_type","entity_id","created_at" DESC)
WHERE "action" NOT IN ('issue.read_marked', 'issue.read_unmarked', 'issue.inbox_archived', 'issue.inbox_unarchived');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_created_idx" ON "heartbeat_runs" USING btree ("company_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_status_created_idx" ON "heartbeat_runs" USING btree ("company_id","status","created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_agent_status_created_idx" ON "heartbeat_runs" USING btree ("company_id","agent_id","status","created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_agent_context_issue_idx" ON "heartbeat_runs" USING btree ("company_id","agent_id",(("context_snapshot" ->> 'issueId')));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_agent_context_task_idx" ON "heartbeat_runs" USING btree ("company_id","agent_id",(("context_snapshot" ->> 'taskId')));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_agent_context_task_key_idx" ON "heartbeat_runs" USING btree ("company_id","agent_id",(("context_snapshot" ->> 'taskKey')));--> statement-breakpoint
DROP INDEX IF EXISTS "agent_wakeup_requests_company_agent_status_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_wakeup_requests_company_agent_status_requested_idx" ON "agent_wakeup_requests" USING btree ("company_id","agent_id","status","requested_at" DESC);
