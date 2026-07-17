ALTER TABLE "plugin_job_runs"
  ADD COLUMN IF NOT EXISTS "triggered_by_actor_type" text;

ALTER TABLE "plugin_job_runs"
  ADD COLUMN IF NOT EXISTS "triggered_by_actor_id" text;

ALTER TABLE "plugin_job_runs"
  ADD COLUMN IF NOT EXISTS "triggered_by_agent_id" uuid REFERENCES "agents"("id");

ALTER TABLE "plugin_job_runs"
  ADD COLUMN IF NOT EXISTS "triggered_by_user_id" text;

ALTER TABLE "plugin_job_runs"
  ADD COLUMN IF NOT EXISTS "triggered_by_run_id" uuid REFERENCES "heartbeat_runs"("id");

ALTER TABLE "plugin_job_runs"
  ADD COLUMN IF NOT EXISTS "responsible_user_id" text;
