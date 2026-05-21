UPDATE issues
SET execution_run_id = NULL
WHERE execution_run_id IS NOT NULL
  AND (
    execution_run_id NOT IN (SELECT id FROM heartbeat_runs)
    OR EXISTS (
      SELECT 1 FROM heartbeat_runs hr
      WHERE hr.id = issues.execution_run_id
        AND hr.status IN ('succeeded', 'failed', 'cancelled', 'timed_out')
    )
  );
