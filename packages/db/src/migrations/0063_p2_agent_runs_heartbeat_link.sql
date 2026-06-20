ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "heartbeat_run_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_agent_runs_heartbeat_run" ON "agent_runs" ("heartbeat_run_id") WHERE "heartbeat_run_id" IS NOT NULL;
