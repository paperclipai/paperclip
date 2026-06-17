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
#   0. Sets agentMonthlyTokens to 5M (sized for a full dev_team chain)
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
# 0. Right-size instance guards so a full pilot chain fits within the cap.
#    The default agentMonthlyTokens was 500k — below one real review pass
#    (~1M), which tripped the hard-stop mid-chain on every HIVA-17 pilot.
#    5M: enough for a full dev_team chain per agent; still stops a genuine
#    runaway cold-resume loop (which would burn 4-5M per agent per replay).
# ---------------------------------------------------------------------------
echo "▶ Ensuring instance guards allow full pilot chains (agentMonthlyTokens → 5M, companyMonthlyTokens → 20M)…"
GUARDS_RESULT="$(curl -fsS -X PATCH "$API_BASE/instance/settings/guards" \
  -H 'Content-Type: application/json' \
  -d '{"budget":{"agentMonthlyTokens":5000000,"companyMonthlyTokens":20000000}}')" || {
    echo "✗ failed to update instance guards (PATCH /instance/settings/guards was rejected)." >&2
    echo "  Refusing to continue: the budget cap would stay at its old value (≤500k), and the" >&2
    echo "  hard-stop would trip mid-chain on the first real review pass — the HIVA-17 failure." >&2
    exit 1
  }
GUARDS_OK="$(printf '%s' "$GUARDS_RESULT" | node -e '
  try {
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
    process.stdout.write(d.budget ? "ok" : "warn");
  } catch (e) { process.stdout.write("warn"); }
')"
if [[ "$GUARDS_OK" != "ok" ]]; then
  echo "✗ guards update returned an unexpected response (no budget object) — cap not confirmed." >&2
  echo "  response: $GUARDS_RESULT" >&2
  exit 1
fi
echo "  agentMonthlyTokens = 5000000 ✓"
echo ""

# ---------------------------------------------------------------------------
# 0b. Enable isolated workspaces so plan child issues run in a git worktree
#     instead of the main checkout. Agent file edits land in a separate
#     worktree the tsx dev-server does not watch → no mid-run server restart
#     → no process_detached orphaned runs (A4/G).
# ---------------------------------------------------------------------------
echo "▶ Enabling isolated workspaces (worktree execution for implementors)…"
IW_RESULT="$(curl -fsS -X PATCH "$API_BASE/instance/settings/experimental" \
  -H 'Content-Type: application/json' \
  -d '{"enableIsolatedWorkspaces":true}' 2>/dev/null || echo '{}')"
IW_OK="$(printf '%s' "$IW_RESULT" | node -e '
  try {
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
    process.stdout.write(d.enableIsolatedWorkspaces === true ? "ok" : "warn");
  } catch (e) { process.stdout.write("warn"); }
')"
if [[ "$IW_OK" == "ok" ]]; then
  echo "  enableIsolatedWorkspaces = true ✓"
else
  echo "  warning: could not enable isolated workspaces (check server log)" >&2
fi
echo ""

# ---------------------------------------------------------------------------
# 1. Clear budget pauses (kill switch). Pilots may still exhaust the cap
#    mid-month after many runs. A plain /resume clears the AGENT flag but
#    not the company-level budget pause — the only safe unpause is resolving
#    each open incident with raise_budget_and_resume (raises the cap above
#    observed + resumes scope).
# ---------------------------------------------------------------------------
echo "▶ Clearing budget pauses…"
curl -fsS -X PATCH "$API_BASE/companies/$COMPANY_ID" \
  -H 'Content-Type: application/json' -d '{"status":"active"}' > /dev/null 2>&1 || true

OVERVIEW_JSON="$(curl -fsS "$API_BASE/companies/$COMPANY_ID/budgets/overview" 2>/dev/null || echo '{}')"
INCIDENT_LINES="$(printf '%s' "$OVERVIEW_JSON" | node -e '
  let d={}; try { d = JSON.parse(require("fs").readFileSync(0,"utf8")); } catch (e) {}
  const incidents = Array.isArray(d.activeIncidents) ? d.activeIncidents : [];
  // raise each cap 5M above observed — enough headroom for the rest of the
  // pilot without silently disabling the kill-switch (old floor was +100M).
  for (const i of incidents) {
    if (i.status !== "open") continue;
    const observed = Number(i.amountObserved || 0);
    const next = Math.max(observed + 5000000, 5000000);
    process.stdout.write(`${i.id} ${Math.floor(next)} ${i.scopeName || i.scopeType}\n`);
  }
')"

if [[ -z "$INCIDENT_LINES" ]]; then
  echo "  no open budget incidents"
else
  printf '%s\n' "$INCIDENT_LINES" | while IFS=' ' read -r INC_ID INC_AMT INC_NAME; do
    [[ -z "$INC_ID" ]] && continue
    RES="$(curl -fsS -X POST "$API_BASE/companies/$COMPANY_ID/budget-incidents/$INC_ID/resolve" \
      -H 'Content-Type: application/json' \
      -d "{\"action\":\"raise_budget_and_resume\",\"amount\":$INC_AMT}" 2>/dev/null || echo '{}')"
    ST="$(printf '%s' "$RES" | node -e 'try{const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(d.status||"?");}catch(e){process.stdout.write("?");}')"
    echo "  resolved $INC_NAME incident -> $ST (cap raised to $INC_AMT)"
  done
fi
echo ""

# ---------------------------------------------------------------------------
# 1. Find all root issues that are plans
# ---------------------------------------------------------------------------
echo "▶ Fetching all issues for company…"
ISSUES_JSON="$(curl -fsS "$API_BASE/companies/$COMPANY_ID/issues?status=backlog,todo,in_progress,in_review,blocked,done,cancelled,stopped&limit=500")" || {
  echo "✗ could not fetch issues for company $COMPANY_ID — reset incomplete." >&2
  echo "  (Budget guards/pauses were already cleared; no plans were deleted.) Fix the server, then re-run." >&2
  exit 1
}

PLAN_IDS="$(printf '%s' "$ISSUES_JSON" | node -e '
  try {
    const issues = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const list = Array.isArray(issues) ? issues : (issues.issues || []);
    // Root issues with no parent = plan roots
    const roots = list.filter((i) => !i.parentIssueId);
    process.stdout.write(roots.map((i) => i.id).join("\n"));
  } catch (e) { process.exit(7); }
')" || {
  echo "✗ unexpected issues response (could not parse) — reset incomplete. Response head:" >&2
  printf '%s\n' "$ISSUES_JSON" | head -c 400 >&2
  echo "" >&2
  exit 1
}

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
# Plans are already deleted by here, so a failed agents fetch must NOT abort and
# orphan the reset — fall back to empty and let the no-CTO path warn-and-skip.
AGENTS_JSON="$(curl -fsS "$API_BASE/companies/$COMPANY_ID/agents" 2>/dev/null || echo '[]')"
CTO_ID="$(printf '%s' "$AGENTS_JSON" | node -e '
  try {
    const agents = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const list = Array.isArray(agents) ? agents : (agents.agents || []);
    const cto = list.find((a) => a.reportsTo == null && (a.role === "cto" || /cto/i.test(a.name)))
              || list.find((a) => a.reportsTo == null);
    process.stdout.write(cto ? cto.id : "");
  } catch (e) { process.stdout.write(""); }
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
  # 6. Ensure CTO heartbeat enabled, maxConcurrentRuns=1, and model=sonnet (A5)
  # -------------------------------------------------------------------------
  echo "▶ Ensuring CTO heartbeat config and model tier…"
  curl -fsS -X PATCH "$API_BASE/agents/$CTO_ID" \
    -H 'Content-Type: application/json' \
    -d '{"runtimeConfig":{"heartbeat":{"enabled":true,"maxConcurrentRuns":1}}}' > /dev/null
  curl -fsS -X PATCH "$API_BASE/agents/$CTO_ID" \
    -H 'Content-Type: application/json' \
    -d '{"adapterConfig":{"model":"claude-sonnet-4-6"}}' > /dev/null
  echo "  heartbeat.enabled=true  maxConcurrentRuns=1  model=claude-sonnet-4-6"

  # -------------------------------------------------------------------------
  # 6b. Resume + enable heartbeat for all non-CTO agents.
  #     After a budget-exhausted pilot, every agent ends up paused with
  #     heartbeat disabled. Only the CTO is fixed above — the rest stay
  #     paused and never pick up new gate tasks (the bug that stalled the
  #     Architect on the first post-reset run, 2026-06-16).
  # -------------------------------------------------------------------------
  echo "▶ Resuming all gate agents and enabling heartbeats…"
  printf '%s' "$AGENTS_JSON" | node -e '
    const agents = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const list = Array.isArray(agents) ? agents : (agents.agents || []);
    // Print id|name for every non-CTO agent
    for (const a of list) {
      if (a.id === process.argv[1]) continue;
      process.stdout.write(a.id + "|" + (a.name ?? a.id) + "\n");
    }
  ' "$CTO_ID" | while IFS='|' read -r AGENT_ID AGENT_NAME; do
    [[ -z "$AGENT_ID" ]] && continue
    curl -fsS -X POST "$API_BASE/agents/$AGENT_ID/resume" \
      -H 'Content-Type: application/json' > /dev/null 2>&1 || true
    curl -fsS -X PATCH "$API_BASE/agents/$AGENT_ID" \
      -H 'Content-Type: application/json' \
      -d '{"runtimeConfig":{"heartbeat":{"enabled":true,"maxConcurrentRuns":1}},"adapterConfig":{"model":"claude-sonnet-4-6"}}' > /dev/null
    echo "  $AGENT_NAME: resumed, heartbeat=on, model=claude-sonnet-4-6"
  done
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
