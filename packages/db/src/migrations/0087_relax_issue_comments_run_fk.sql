-- Drop the strict FK on issue_comments.created_by_run_id so external callers
-- with ad-hoc run UUIDs (e.g. CEO curl/script runs) can post comments without
-- a pre-existing heartbeat_runs row. The column is kept for audit purposes.
-- Existing comments that reference valid runs are unaffected.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_comments_created_by_run_id_heartbeat_runs_id_fk') THEN
    ALTER TABLE "issue_comments" DROP CONSTRAINT "issue_comments_created_by_run_id_heartbeat_runs_id_fk";
  END IF;
END $$;
