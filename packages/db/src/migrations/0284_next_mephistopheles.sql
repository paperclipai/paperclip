ALTER TABLE "secret_access_events" DROP CONSTRAINT IF EXISTS "secret_access_events_issue_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "secret_access_events" DROP CONSTRAINT IF EXISTS "secret_access_events_heartbeat_run_id_heartbeat_runs_id_fk";
