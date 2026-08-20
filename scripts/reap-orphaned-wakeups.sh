#!/usr/bin/env bash
#
# reap-orphaned-wakeups.sh — cancel agent_wakeup_requests whose linked issue is
# already done/cancelled (orphaned cruft the live recovery loop never clears).
#
# Background: reapStaleQueuedRuns reaps heartbeat_runs but NOT agent_wakeup_requests,
# so wakeups deferred/queued against an issue that later resolves accumulate forever.
# This drains them using the SAME terminal-status convention the recovery service uses
# when it clears a wakeup on a terminal run (status='cancelled', finished_at, updated_at).
#
# DRY-RUN by default (read-only). Pass --apply to actually cancel.
#
# Scope (orphaned == safe to cancel):
#   - status in (queued, deferred_issue_execution)
#   - linked issue (payload->>'issueId' | 'taskId') has status in (done, cancelled)
# Deliberately LEFT alone: wakeups whose issue is still open (blocked/todo/etc.) and
# wakeups with no linked issue — those may be legitimately waiting.
#
# Usage:
#   scripts/reap-orphaned-wakeups.sh            # dry-run: show what would be cancelled
#   scripts/reap-orphaned-wakeups.sh --apply    # cancel them (transactional)
#   scripts/reap-orphaned-wakeups.sh --check-live-stale
#       report queued/deferred wakes older than six hours whose issue is still live
#       (or missing); exit 1 when found so guard-bus can create owned remediation
#   scripts/reap-orphaned-wakeups.sh --check-monitors
#       report stored issue monitors that cannot fire, are exhausted, or are overdue
#
set -euo pipefail

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-54329}"
PGUSER="${PGUSER:-paperclip}"
PGDATABASE="${PGDATABASE:-paperclip}"
export PGPASSWORD="${PGPASSWORD:-paperclip}"
PSQL=(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1)

ORPHAN_PREDICATE="aw.status IN ('queued','deferred_issue_execution')
  AND EXISTS (
    SELECT 1 FROM issues i
    WHERE i.id::text = COALESCE(aw.payload->>'issueId', aw.payload->>'taskId')
      AND i.status IN ('done','cancelled')
  )"

APPLY=0
CHECK_LIVE_STALE=0
CHECK_MONITORS=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --check-live-stale) CHECK_LIVE_STALE=1 ;;
    --check-monitors) CHECK_MONITORS=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [[ $((CHECK_LIVE_STALE + CHECK_MONITORS)) -gt 1 ]]; then
  echo "choose only one check mode" >&2
  exit 2
fi

if [[ "$CHECK_MONITORS" -eq 1 ]]; then
  MONITOR_BAD_PREDICATE="i.monitor_next_check_at IS NOT NULL AND (
       i.status NOT IN ('in_progress','in_review')
    OR i.assignee_agent_id IS NULL
    OR i.assignee_user_id IS NOT NULL
    OR a.status IN ('paused','disabled','archived','terminated','error')
    OR coalesce(i.execution_policy #>> '{monitor,kind}','') = ''
    OR coalesce(i.execution_policy #>> '{monitor,serviceName}','') = ''
    OR coalesce(i.execution_policy #>> '{monitor,timeoutAt}','') = ''
    OR coalesce(nullif(i.execution_policy #>> '{monitor,maxAttempts}','')::int,0) < 1
    OR i.monitor_attempt_count >= coalesce(
         nullif(i.execution_policy #>> '{monitor,maxAttempts}','')::int,2147483647)
    OR i.monitor_next_check_at < now() - interval '2 hours'
  )"
  echo "== ineligible/exhausted/overdue issue monitors =="
  "${PSQL[@]}" -tA -F '|' -c "
    SELECT i.identifier, i.status, coalesce(a.name,'NO_AGENT'), coalesce(a.status,'missing'),
           i.monitor_next_check_at, i.monitor_attempt_count,
           concat_ws(',',
             CASE WHEN i.status NOT IN ('in_progress','in_review') THEN 'ineligible_status' END,
             CASE WHEN i.assignee_agent_id IS NULL THEN 'no_agent' END,
             CASE WHEN i.assignee_user_id IS NOT NULL THEN 'user_assigned' END,
             CASE WHEN a.status IN ('paused','disabled','archived','terminated','error')
                  THEN 'owner_not_invokable' END,
             CASE WHEN coalesce(i.execution_policy #>> '{monitor,kind}','') = ''
                  THEN 'missing_kind' END,
             CASE WHEN coalesce(i.execution_policy #>> '{monitor,serviceName}','') = ''
                  THEN 'missing_service' END,
             CASE WHEN coalesce(i.execution_policy #>> '{monitor,timeoutAt}','') = ''
                  THEN 'missing_timeout' END,
             CASE WHEN coalesce(nullif(i.execution_policy #>> '{monitor,maxAttempts}','')::int,0) < 1
                  THEN 'missing_attempt_cap' END,
             CASE WHEN i.monitor_attempt_count >= coalesce(
                        nullif(i.execution_policy #>> '{monitor,maxAttempts}','')::int,2147483647)
                  THEN 'attempts_exhausted' END,
             CASE WHEN i.monitor_next_check_at < now() - interval '2 hours'
                  THEN 'overdue' END)
    FROM issues i LEFT JOIN agents a ON a.id=i.assignee_agent_id
    WHERE $MONITOR_BAD_PREDICATE
    ORDER BY i.monitor_next_check_at;"
  MONITOR_BAD_TOTAL=$("${PSQL[@]}" -tA -c \
    "SELECT count(*) FROM issues i LEFT JOIN agents a ON a.id=i.assignee_agent_id
     WHERE $MONITOR_BAD_PREDICATE;")
  echo "bad_monitors=${MONITOR_BAD_TOTAL}"
  if [[ "$MONITOR_BAD_TOTAL" != "0" ]]; then
    exit 1
  fi
  exit 0
fi

if [[ "$CHECK_LIVE_STALE" -eq 1 ]]; then
  LIVE_STALE_HOURS=6
  # A queued heartbeat run with a future retry deadline is an intentional,
  # persisted execution path (for example an activity-window or provider-quota
  # deferral), not a stale wake. The wake's requested_at remains the original
  # enqueue time, so age alone would otherwise turn a healthy deferral red.
  # `retryNotBefore` is the canonical persisted value; retain the transient
  # spelling for rows written by older recovery paths.
  LIVE_STALE_PREDICATE="aw.status IN ('queued','deferred_issue_execution')
    AND aw.requested_at < now() - interval '${LIVE_STALE_HOURS} hours'
    AND NOT EXISTS (
      SELECT 1 FROM issues terminal_issue
      WHERE terminal_issue.id::text = COALESCE(aw.payload->>'issueId', aw.payload->>'taskId')
        AND terminal_issue.status IN ('done','cancelled')
    )
    AND NOT EXISTS (
      SELECT 1 FROM heartbeat_runs deferred_run
      WHERE deferred_run.wakeup_request_id = aw.id
        AND deferred_run.status = 'queued'
        AND COALESCE(
          NULLIF(deferred_run.result_json->>'retryNotBefore', '')::timestamptz,
          NULLIF(deferred_run.result_json->>'transientRetryNotBefore', '')::timestamptz,
          deferred_run.scheduled_retry_at
        ) > now()
    )"

  echo "== stale live/missing wakeups (>${LIVE_STALE_HOURS}h) =="
  "${PSQL[@]}" -tA -F '|' -c "
    SELECT aw.id, aw.status,
           round(extract(epoch FROM (now()-aw.requested_at))/3600.0,1) AS age_h,
           coalesce(i.identifier,'NO_LINKED_ISSUE'), coalesce(i.status,'missing'),
           coalesce(a.name,'NO_AGENT'), coalesce(a.status,'missing')
    FROM agent_wakeup_requests aw
    LEFT JOIN issues i
      ON i.id::text = COALESCE(aw.payload->>'issueId', aw.payload->>'taskId')
    LEFT JOIN agents a ON a.id=aw.agent_id
    WHERE $LIVE_STALE_PREDICATE
    ORDER BY aw.requested_at;"
  LIVE_STALE_TOTAL=$("${PSQL[@]}" -tA -c \
    "SELECT count(*) FROM agent_wakeup_requests aw WHERE $LIVE_STALE_PREDICATE;")
  echo "stale_live_or_missing=${LIVE_STALE_TOTAL}"
  if [[ "$LIVE_STALE_TOTAL" != "0" ]]; then
    exit 1
  fi
  exit 0
fi

echo "== orphaned wakeups (linked issue done/cancelled) =="
"${PSQL[@]}" -tA -c "
  SELECT i.status AS issue_status, aw.status AS wake_status, count(*)
  FROM agent_wakeup_requests aw
  JOIN issues i ON i.id::text = COALESCE(aw.payload->>'issueId', aw.payload->>'taskId')
  WHERE $ORPHAN_PREDICATE
  GROUP BY 1,2 ORDER BY 3 DESC;"

TOTAL=$("${PSQL[@]}" -tA -c "SELECT count(*) FROM agent_wakeup_requests aw WHERE $ORPHAN_PREDICATE;")
echo "total orphaned: ${TOTAL}"

if [[ "$APPLY" -ne 1 ]]; then
  echo
  echo "DRY-RUN — nothing changed. Re-run with --apply to cancel the ${TOTAL} above."
  exit 0
fi

echo
echo "Applying (transactional)..."
"${PSQL[@]}" -tA -c "
  BEGIN;
  UPDATE agent_wakeup_requests aw
  SET status='cancelled', finished_at=now(), updated_at=now()
  WHERE $ORPHAN_PREDICATE;
  COMMIT;"

# Verify the exact class this reaper owns. The old log printed every queued/deferred
# request as `remaining_stale`, including legitimate waits on live issues; that made a
# successful pass look red and still did not fail when a real orphan survived.
REMAINING_ORPHANED=$("${PSQL[@]}" -tA -c \
  "SELECT count(*) FROM agent_wakeup_requests aw WHERE $ORPHAN_PREDICATE;")
WAITING_NON_ORPHANED=$("${PSQL[@]}" -tA -c \
  "SELECT count(*) FROM agent_wakeup_requests aw
   WHERE aw.status IN ('queued','deferred_issue_execution')
     AND NOT ($ORPHAN_PREDICATE);")
echo "remaining_orphaned=${REMAINING_ORPHANED}"
echo "waiting_non_orphaned=${WAITING_NON_ORPHANED}"
if [[ "$REMAINING_ORPHANED" != "0" ]]; then
  echo "ERROR: orphan reaper left ${REMAINING_ORPHANED} owned row(s) behind" >&2
  exit 1
fi
echo "done."
