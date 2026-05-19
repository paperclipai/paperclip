DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activity_log_run_id_heartbeat_runs_id_fk') THEN
    ALTER TABLE "activity_log" DROP CONSTRAINT "activity_log_run_id_heartbeat_runs_id_fk";
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_comments_created_by_run_id_heartbeat_runs_id_fk') THEN
    ALTER TABLE "issue_comments" DROP CONSTRAINT "issue_comments_created_by_run_id_heartbeat_runs_id_fk";
  END IF;
END $$;
