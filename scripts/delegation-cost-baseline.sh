#!/usr/bin/env bash
# Delegation cost baseline — compare manager coordination heartbeats vs delegation runs.
#
# Usage (requires running Paperclip + DATABASE_URL or embedded PGlite data dir):
#   ./scripts/delegation-cost-baseline.sh [company_id] [manager_agent_id] [days]
#
# Metrics printed:
# - manager heartbeats per day (all runs + a2a_delegate children)
# - estimated coordination cost from cost_events linked to manager runs
# - child delegation runs count

set -euo pipefail

COMPANY_ID="${1:-}"
MANAGER_ID="${2:-}"
DAYS="${3:-7}"
API_URL="${PAPERCLIP_API_URL:-http://localhost:3100}"

if [[ -z "$COMPANY_ID" || -z "$MANAGER_ID" ]]; then
  echo "Usage: $0 <company_id> <manager_agent_id> [days]" >&2
  exit 1
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "Note: DATABASE_URL unset — queries below assume psql access to the dev DB." >&2
  echo "Set DATABASE_URL or run against your embedded PGlite export." >&2
fi

SINCE=$(date -u -v-"${DAYS}"d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "-${DAYS} days" +%Y-%m-%dT%H:%M:%SZ)

echo "=== Paperclip delegation cost baseline ==="
echo "Company: $COMPANY_ID"
echo "Manager agent: $MANAGER_ID"
echo "Window: last ${DAYS} days (since $SINCE)"
echo "API: $API_URL"
echo

if [[ -n "${DATABASE_URL:-}" ]]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL
\\echo 'Manager runs per day'
SELECT date_trunc('day', created_at) AS day,
       count(*) AS manager_runs,
       count(*) FILTER (WHERE context_snapshot->>'wakeReason' = 'a2a_delegate') AS delegate_child_runs,
       count(*) FILTER (WHERE context_snapshot->>'wakeReason' = 'delegation_child_completed') AS delegation_continuations
FROM heartbeat_runs
WHERE company_id = '$COMPANY_ID'
  AND agent_id = '$MANAGER_ID'
  AND created_at >= '$SINCE'
GROUP BY 1
ORDER BY 1;

\\echo ''
\\echo 'Manager coordination cost (USD) from cost_events'
SELECT date_trunc('day', ce.occurred_at) AS day,
       round(sum(ce.cost_usd)::numeric, 4) AS usd
FROM cost_events ce
INNER JOIN heartbeat_runs hr ON hr.id = ce.heartbeat_run_id
WHERE hr.company_id = '$COMPANY_ID'
  AND hr.agent_id = '$MANAGER_ID'
  AND ce.occurred_at >= '$SINCE'
GROUP BY 1
ORDER BY 1;

\\echo ''
\\echo 'Active delegation trees (parent with pending children)'
SELECT parent.id AS parent_run_id,
       parent.delegation_status,
       count(child.id) AS child_runs
FROM heartbeat_runs parent
LEFT JOIN heartbeat_runs child ON child.parent_run_id = parent.id
WHERE parent.company_id = '$COMPANY_ID'
  AND parent.agent_id = '$MANAGER_ID'
  AND parent.delegation_status IS NOT NULL
  AND parent.created_at >= '$SINCE'
GROUP BY parent.id, parent.delegation_status
ORDER BY parent.created_at DESC
LIMIT 20;
SQL
else
  echo "Skipping SQL — set DATABASE_URL to print metrics."
  echo "After enabling A2A delegate, re-run and compare manager_runs/day and usd/day."
fi

echo
echo "Async baseline (pre-delegate): expect higher manager_runs on days with manual child-issue follow-up."
echo "Post-delegate: expect fewer manager runs per completed CEO→report handoff when using wait:true."
