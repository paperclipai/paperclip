-- up: add run_git_state column to heartbeat_runs table (LIF-456)
ALTER TABLE "heartbeat_runs" ADD COLUMN "run_git_state" jsonb;
