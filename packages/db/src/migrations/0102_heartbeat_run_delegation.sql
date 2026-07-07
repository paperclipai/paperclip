ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "parent_run_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "delegation_status" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "delegation_result_json" jsonb;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'heartbeat_runs_parent_run_id_heartbeat_runs_id_fk') THEN
  ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_parent_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_parent_run_idx" ON "heartbeat_runs" USING btree ("parent_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_pending_delegation_idx" ON "heartbeat_runs" USING btree ("delegation_status") WHERE "heartbeat_runs"."delegation_status" = 'pending';
