ALTER TABLE "cost_events" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cost_events_run_id_unique_idx" ON "cost_events" USING btree ("run_id") WHERE run_id IS NOT NULL;
