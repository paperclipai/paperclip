ALTER TABLE "activity_log" DROP CONSTRAINT "activity_log_run_id_heartbeat_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_task_sessions" DROP CONSTRAINT "agent_task_sessions_last_run_id_heartbeat_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" DROP CONSTRAINT "heartbeat_run_events_run_id_heartbeat_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD CONSTRAINT "agent_task_sessions_last_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ADD CONSTRAINT "heartbeat_run_events_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;