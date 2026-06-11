ALTER TABLE "agent_task_sessions" ADD COLUMN "consecutive_failure_count" integer DEFAULT 0 NOT NULL;
