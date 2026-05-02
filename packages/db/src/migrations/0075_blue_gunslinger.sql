ALTER TABLE "heartbeat_runs" ADD COLUMN "last_liveness_at" timestamp with time zone;--> statement-breakpoint
UPDATE "heartbeat_runs"
SET "last_liveness_at" = COALESCE("last_output_at", "process_started_at", "started_at", "created_at")
WHERE "last_liveness_at" IS NULL;--> statement-breakpoint
CREATE INDEX "heartbeat_runs_company_status_last_liveness_idx" ON "heartbeat_runs" USING btree ("company_id","status","last_liveness_at");