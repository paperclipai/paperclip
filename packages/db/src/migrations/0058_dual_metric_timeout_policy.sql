ALTER TABLE "heartbeat_runs"
ADD COLUMN IF NOT EXISTS "last_activity_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_running_last_activity_idx"
ON "heartbeat_runs" USING btree ("company_id", "status", "last_activity_at")
WHERE "status" = 'running';
