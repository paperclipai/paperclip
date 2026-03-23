ALTER TABLE "cost_events" ADD COLUMN "adapter_type" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_events_company_adapter_occurred_idx" ON "cost_events" ("company_id", "adapter_type", "occurred_at");--> statement-breakpoint
UPDATE "cost_events" ce
SET "adapter_type" = a."adapter_type"
FROM "agents" a
WHERE ce."agent_id" = a."id" AND ce."adapter_type" IS NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "issue_id" uuid REFERENCES "issues"("id"),
  "created_by" text NOT NULL DEFAULT 'system',
  "name" text,
  "steps" jsonb NOT NULL DEFAULT '[]',
  "current_step" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'pending',
  "on_step_failure" text NOT NULL DEFAULT 'pause',
  "max_retries" integer NOT NULL DEFAULT 1,
  "timeout_per_step_ms" integer NOT NULL DEFAULT 300000,
  "result" jsonb,
  "error" text,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_runs_company_status_idx" ON "workflow_runs" ("company_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_runs_issue_idx" ON "workflow_runs" ("issue_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_step_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_run_id" uuid NOT NULL REFERENCES "workflow_runs"("id") ON DELETE CASCADE,
  "step_index" integer NOT NULL,
  "adapter_type" text NOT NULL,
  "agent_id" uuid REFERENCES "agents"("id"),
  "run_id" uuid REFERENCES "heartbeat_runs"("id"),
  "status" text NOT NULL DEFAULT 'pending',
  "prompt" text,
  "result" jsonb,
  "error" text,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_step_runs_workflow_idx" ON "workflow_step_runs" ("workflow_run_id", "step_index");
