-- Down: add_agent_executor

DROP INDEX IF EXISTS "agents_executor_idx";
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_executor_check";
ALTER TABLE "agents" DROP COLUMN IF EXISTS "executor";
