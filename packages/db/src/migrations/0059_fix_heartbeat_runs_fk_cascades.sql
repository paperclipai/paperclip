-- Add ON DELETE SET NULL to FK constraints that reference heartbeat_runs.id.
-- Without these, deleting heartbeat_runs rows (e.g. during company teardown)
-- fails with FK violations from child tables that may be deleted in wrong order
-- or missed entirely (#5163). SET NULL is correct for all of these since the
-- referenced run is optional metadata on each row.

ALTER TABLE "cost_events"
  DROP CONSTRAINT IF EXISTS "cost_events_heartbeat_run_id_heartbeat_runs_id_fk",
  ADD CONSTRAINT "cost_events_heartbeat_run_id_heartbeat_runs_id_fk"
    FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "finance_events"
  DROP CONSTRAINT IF EXISTS "finance_events_heartbeat_run_id_heartbeat_runs_id_fk",
  ADD CONSTRAINT "finance_events_heartbeat_run_id_heartbeat_runs_id_fk"
    FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "activity_log"
  DROP CONSTRAINT IF EXISTS "activity_log_run_id_heartbeat_runs_id_fk",
  ADD CONSTRAINT "activity_log_run_id_heartbeat_runs_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "agent_task_sessions"
  DROP CONSTRAINT IF EXISTS "agent_task_sessions_last_run_id_heartbeat_runs_id_fk",
  ADD CONSTRAINT "agent_task_sessions_last_run_id_heartbeat_runs_id_fk"
    FOREIGN KEY ("last_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "heartbeat_run_events"
  DROP CONSTRAINT IF EXISTS "heartbeat_run_events_run_id_heartbeat_runs_id_fk",
  ADD CONSTRAINT "heartbeat_run_events_run_id_heartbeat_runs_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
