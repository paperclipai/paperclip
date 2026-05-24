-- Productivity review scopes issue runs through generated context columns.
-- Keep the lookup narrow by company, agent, and context key before ordering
-- by recency.
CREATE INDEX IF NOT EXISTS "idx_heartbeat_runs_company_agent_context_issue_created"
  ON "heartbeat_runs" USING btree ("company_id", "agent_id", "context_issue_id", "created_at" DESC, "id" DESC)
  WHERE "context_issue_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_heartbeat_runs_company_agent_context_task_created"
  ON "heartbeat_runs" USING btree ("company_id", "agent_id", "context_task_id", "created_at" DESC, "id" DESC)
  WHERE "context_task_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_heartbeat_runs_company_agent_context_task_key_created"
  ON "heartbeat_runs" USING btree ("company_id", "agent_id", "context_task_key", "created_at" DESC, "id" DESC)
  WHERE "context_task_key" IS NOT NULL;
