\set ON_ERROR_STOP on
BEGIN READ ONLY;
SELECT :'from_utc'::timestamptz AS observation_start,
       :'until_utc'::timestamptz AS observation_end;
WITH scoped_issues AS (
  SELECT id FROM issues
  WHERE company_id = :'company_id'::uuid
    AND (id = :'issue_id'::uuid OR parent_id = :'issue_id'::uuid)
), sweeps AS (
  SELECT r.id, r.agent_id, r.status, r.started_at, r.finished_at,
         r.context_snapshot ->> 'issueId' AS issue_id,
         r.context_snapshot ->> 'wakeReason' AS wake_reason
  FROM heartbeat_runs r
  WHERE r.company_id = :'company_id'::uuid
    AND (r.context_snapshot ->> 'issueId' IN (SELECT id::text FROM scoped_issues)
      OR r.context_snapshot ->> 'taskId' IN (SELECT id::text FROM scoped_issues))
    AND COALESCE(r.finished_at, r.started_at, r.created_at)
      BETWEEN :'from_utc'::timestamptz AND :'until_utc'::timestamptz
)
SELECT s.*, repair.id AS repair_run_id, repair.status AS repair_status,
       repair.created_at AS repair_created_at,
       repair.context_snapshot -> 'legacyDispositionEpisode' AS repair_episode
FROM sweeps s
LEFT JOIN heartbeat_runs repair ON repair.company_id = :'company_id'::uuid
  AND repair.context_snapshot ->> 'dispositionRepairSourceRunId' = s.id::text
ORDER BY COALESCE(s.started_at, s.finished_at), repair.created_at;
SELECT rr.id AS routine_run_id, rr.source, rr.status, rr.triggered_at,
       rr.linked_issue_id, t.id AS trigger_id, t.enabled, t.next_run_at
FROM routines r
JOIN routine_triggers t ON t.routine_id = r.id AND t.company_id = r.company_id
LEFT JOIN routine_runs rr ON rr.trigger_id = t.id AND rr.company_id = r.company_id
  AND rr.triggered_at BETWEEN :'from_utc'::timestamptz AND :'until_utc'::timestamptz
WHERE r.company_id = :'company_id'::uuid AND r.parent_issue_id = :'issue_id'::uuid
ORDER BY rr.triggered_at;
ROLLBACK;
