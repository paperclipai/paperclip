ALTER TABLE "activity_log" DROP CONSTRAINT IF EXISTS "activity_log_run_id_heartbeat_runs_id_fk";
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'activity_log_run_id_heartbeat_runs_id_fk'
  ) THEN
    ALTER TABLE "activity_log"
      ADD CONSTRAINT "activity_log_run_id_heartbeat_runs_id_fk"
      FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END$$;
