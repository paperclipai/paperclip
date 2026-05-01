ALTER TABLE "routine_runs" ADD COLUMN IF NOT EXISTS "consumed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN IF NOT EXISTS "consumed_by_heartbeat_run_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_consumed_by_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("consumed_by_heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routine_runs_routine_consumed_idx"
  ON "routine_runs" USING btree ("routine_id","consumed_at");
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "dormancy_alarm_fire_count_threshold" integer DEFAULT 3 NOT NULL;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "dormancy_alarm_stale_hours" integer DEFAULT 12 NOT NULL;
