-- Deleting an agent (or a company) deletes its heartbeat_runs rows, but
-- heartbeat_run_events.run_id had no ON DELETE behavior: any event row still
-- referencing a run (even one whose own agent_id column didn't match the
-- agent being deleted -- e.g. a reassigned run, or a race with a live
-- heartbeat process appending events) blocked the heartbeat_runs delete with
-- a foreign key violation. heartbeat_run_watchdog_decisions.run_id already
-- cascades on heartbeat_runs deletion; align heartbeat_run_events with that
-- established pattern so the DB enforces cleanup instead of relying on the
-- application deleting every event row up front.
ALTER TABLE "heartbeat_run_events" DROP CONSTRAINT IF EXISTS "heartbeat_run_events_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ADD CONSTRAINT "heartbeat_run_events_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
