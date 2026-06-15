#!/usr/bin/env bash
#
# reset-pilot.sh — wipe all plans, clear the CTO session, and optionally seed a
# fresh draft plan so you can run the MyHive pilot from a clean slate.
#
# Usage:
#   scripts/reset-pilot.sh <companyId> [--create-plan] [<profile>] [<title>]
#
#   <companyId>     required — Hive Pilot company UUID
#   --create-plan   optional — after reset, create a fresh draft plan
#   <profile>       light | full  (default: light)  — only used with --create-plan
#   <title>         optional plan title override
#
# What it does:
#   1. Stops every active plan (cancels running subtree)
#   2. Deletes every plan issue + its subtree
#   3. Resets the root CTO's Claude session (clears --resume state)
#   4. Resumes the CTO (clears budget/pause flags)
#   5. Ensures CTO heartbeat is enabled with maxConcurrentRuns=1
#   6. If --create-plan: calls create-pilot-plan.sh for a fresh draft
#
# Env:
#   API_BASE   (default http://127.0.0.1:3100/api)
#
set -euo pipefail

API_BASE="${API_BASE:-http://127.0.0.1:3100/api}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

COMPANY_ID="${1:-}"
if [[ -z "$COMPANY_ID" ]]; then
  echo "usage: $0 <companyId> [--create-plan] [<profile>] [<title>]" >&2
  exit 2
fi
shift

CREATE_PLAN=false
PROFILE="light"
PLAN_TITLE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --create-plan) CREATE_PLAN=true ;;
    light|full|solo|none|dev_team) PROFILE="$1" ;;
    *) PLAN_TITLE="$1" ;;
  esac
  shift
done

echo "▶ API_BASE=$API_BASE"
echo "▶ company=$COMPANY_ID"
echo ""

# ---------------------------------------------------------------------------
# 1. Find all root issues that are plans
# ---------------------------------------------------------------------------
echo "▶ Fetching all issues for company…"
ISSUES_JSON="$(curl -fsS "$API_BASE/companies/$COMPANY_ID/issues?status=backlog,todo,in_progress,in_review,blocked,done,cancelled,stopped&limit=500")"

PLAN_IDS="$(printf '%s' "$ISSUES_JSON" | node -e '
  const issues = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const list = Array.isArray(issues) ? issues : (issues.issues || []);
  // Root issues with no parent = plan roots
  const roots = list.filter((i) => !i.parentIssueId);
  process.stdout.write(roots.map((i) => i.id).join("\n"));
')"

if [[ -z "$PLAN_IDS" ]]; then
  echo "  no plans found — nothing to delete"
else
  echo "  found plans: $(echo "$PLAN_IDS" | tr '\n' ' ')"
fi

# ---------------------------------------------------------------------------
# 2. Stop then delete each plan
# ---------------------------------------------------------------------------
for PLAN_ID in $(printf '%s' "$PLAN_IDS" | tr -d '\r' | tr '\n' ' '); do
  [[ -z "$PLAN_ID" ]] && continue

  echo ""
  echo ">> Stopping plan ${PLAN_ID}"
  STOP_RESULT="$(curl -fsS -X POST "$API_BASE/plans/$PLAN_ID/stop" \
    -H 'Content-Type: application/json' \
    -d '{"reason":"reset-pilot.sh — clearing before fresh start"}' 2>/dev/null || echo '{}')"
  RUNS_CANCELLED="$(printf '%s' "$STOP_RESULT" | node -e '
    try { const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(d.runsCancelled||0)); } catch(e){ process.stdout.write("0"); }')"
  echo "  runs cancelled: $RUNS_CANCELLED"

  echo ">> Deleting plan ${PLAN_ID}"
  DEL_RESULT="$(curl -fsS -X DELETE "$API_BASE/plans/$PLAN_ID" 2>/dev/null || echo '{}')"
  DEL_COUNT="$(printf '%s' "$DEL_RESULT" | node -e '
    try { const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String((d.deletedIssueIds||[]).length)); } catch(e){ process.stdout.write("?"); }')"
  echo "  deleted $DEL_COUNT issue(s)"
done

# ---------------------------------------------------------------------------
# 3. Find the root CTO
# ---------------------------------------------------------------------------
echo ""
echo "▶ Looking up root CTO for company…"
AGENTS_JSON="$(curl -fsS "$API_BASE/companies/$COMPANY_ID/agents")"
CTO_ID="$(printf '%s' "$AGENTS_JSON" | node -e '
  const agents = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const list = Array.isArray(agents) ? agents : (agents.agents || []);
  const cto = list.find((a) => a.reportsTo == null && (a.role === "cto" || /cto/i.test(a.name)))
            || list.find((a) => a.reportsTo == null);
  process.stdout.write(cto ? cto.id : "");
')"

if [[ -z "$CTO_ID" ]]; then
  echo "  ✗ no root CTO found — skipping session reset" >&2
else
  echo "  CTO agent: $CTO_ID"

  # -------------------------------------------------------------------------
  # 4. Reset CTO session (clears --resume / accumulated transcript)
  # -------------------------------------------------------------------------
  echo "▶ Resetting CTO session…"
  RESET_RESULT="$(curl -fsS -X POST "$API_BASE/agents/$CTO_ID/runtime-state/reset-session" \
    -H 'Content-Type: application/json' \
    -d '{}')"
  CLEARED="$(printf '%s' "$RESET_RESULT" | node -e '
    try { const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(d.clearedTaskSessions||0)); } catch(e){ process.stdout.write("?"); }')"
  echo "  cleared $CLEARED task sessions — sessionId now null"

  # -------------------------------------------------------------------------
  # 5. Resume (clears budget/pause flags)
  # -------------------------------------------------------------------------
  echo "▶ Resuming CTO (clearing budget/pause flags)…"
  RESUME_RESULT="$(curl -fsS -X POST "$API_BASE/agents/$CTO_ID/resume" \
    -H 'Content-Type: application/json')"
  STATUS="$(printf '%s' "$RESUME_RESULT" | node -e '
    try { const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(d.status||"?"); } catch(e){ process.stdout.write("?"); }')"
  echo "  CTO status: $STATUS"

  # -------------------------------------------------------------------------
  # 6. Ensure heartbeat enabled, maxConcurrentRuns=1
  # -------------------------------------------------------------------------
  echo "▶ Ensuring CTO heartbeat config…"
  curl -fsS -X PATCH "$API_BASE/agents/$CTO_ID" \
    -H 'Content-Type: application/json' \
    -d '{"runtimeConfig":{"heartbeat":{"enabled":true,"maxConcurrentRuns":1}}}' > /dev/null
  echo "  heartbeat.enabled=true  maxConcurrentRuns=1"
fi

# ---------------------------------------------------------------------------
# 7. Optionally create a fresh draft plan
# ---------------------------------------------------------------------------
echo ""
if [[ "$CREATE_PLAN" == "true" ]]; then
  echo "▶ Creating fresh draft plan (profile=$PROFILE)…"
  if [[ -n "$PLAN_TITLE" ]]; then
    bash "$SCRIPT_DIR/create-pilot-plan.sh" "$COMPANY_ID" "$PROFILE" "$PLAN_TITLE"
  else
    bash "$SCRIPT_DIR/create-pilot-plan.sh" "$COMPANY_ID" "$PROFILE"
  fi
else
  echo "Reset complete. Create a new plan with:"
  echo "  scripts/create-pilot-plan.sh $COMPANY_ID light"
  echo "  scripts/create-pilot-plan.sh $COMPANY_ID full"
  echo ""
  echo "Then activate it with:"
  echo "  curl -fsS -X POST $API_BASE/plans/<planId>/activate"
fi
