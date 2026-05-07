-- down: drop run_git_state column from heartbeat_runs table (LIF-456)
ALTER TABLE "heartbeat_runs" DROP COLUMN IF EXISTS "run_git_state";
