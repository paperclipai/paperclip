ALTER TABLE "rt2_v33_execution_attempts"
  DROP CONSTRAINT IF EXISTS "rt2_v33_execution_attempts_state_check";

ALTER TABLE "rt2_v33_execution_attempts"
  ADD CONSTRAINT "rt2_v33_execution_attempts_state_check"
  CHECK ("state" in ('queued', 'dispatched', 'claimed', 'running', 'completed', 'failed', 'cancelled', 'blocked'));
