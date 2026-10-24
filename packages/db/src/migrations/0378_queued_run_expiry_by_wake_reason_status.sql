-- queued_run_expired grouped by hour x company x wake reason x target status at
-- enqueue. This is the counter that was previously reconstructed by hand from
-- `heartbeat_runs.context_snapshot->>'issueId'` plus a query-time issue status
-- read, which cannot answer "what status did the wake target when it was
-- queued" once the target has moved on.
--
-- status_at_enqueue comes from the stamp the wake enqueue transaction writes
-- (contextSnapshot.issueStatusAtEnqueue in server/src/services/heartbeat/queue.ts),
-- taken from the locked issue row. Rows queued before that stamp read
-- '(unstamped)' and must not be mixed into a post-deploy trend.
--
-- Additive and idempotent: hand-applied instances that already created this view
-- from ~/.paperclip/patches/prx-6004/counter.sql get the same definition.
CREATE OR REPLACE VIEW "v_queued_run_expiry_by_wake_reason_status" AS
SELECT
  date_trunc('hour', r."finished_at") AS "hour",
  r."company_id" AS "company_id",
  coalesce(w."reason", r."context_snapshot" ->> 'wakeReason', '(unknown)') AS "wake_reason",
  coalesce(r."context_snapshot" ->> 'issueStatusAtEnqueue', '(unstamped)') AS "status_at_enqueue",
  count(*)::int AS "expiries",
  count(DISTINCT r."context_snapshot" ->> 'issueId')::int AS "issues"
FROM "heartbeat_runs" r
LEFT JOIN "agent_wakeup_requests" w ON w."id" = r."wakeup_request_id"
WHERE r."error_code" = 'queued_run_expired'
GROUP BY 1, 2, 3, 4;
