ALTER TABLE agent_failure_state ADD COLUMN consecutive_successes integer NOT NULL DEFAULT 0;
