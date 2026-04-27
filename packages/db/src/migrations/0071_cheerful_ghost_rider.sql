ALTER TABLE "heartbeat_runs" ADD COLUMN "parent_run_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_parent_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "heartbeat_runs_parent_run_idx" ON "heartbeat_runs" USING btree ("parent_run_id");
