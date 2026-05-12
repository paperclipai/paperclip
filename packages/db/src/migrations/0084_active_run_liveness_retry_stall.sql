ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_liveness_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_retry_attempt" integer;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_retry_error_status" text;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_retry_error_message" text;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "retry_stall_started_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_status_last_liveness_idx"
  ON "heartbeat_runs" USING btree ("company_id","status","last_liveness_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_status_retry_stall_idx"
  ON "heartbeat_runs" USING btree ("company_id","status","retry_stall_started_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_runtime_api_retry_exhausted_uq"
  ON "issues" USING btree ("company_id","origin_kind","origin_id")
  WHERE "origin_kind" = 'runtime_api_retry_exhausted'
    AND "origin_id" IS NOT NULL
    AND "hidden_at" IS NULL
    AND "status" NOT IN ('done', 'cancelled');
