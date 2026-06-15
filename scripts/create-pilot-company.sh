#!/usr/bin/env bash
#
# create-pilot-company.sh — spin up a fresh, gate-ready company for a MyHive pilot.
#
# Hits the RUNNING server's HTTP API (POST /api/companies), which auto-provisions
# the dev-team gate squad (CTO + Architect + Code Reviewer + Wiring Expert +
# Implementor 1/2). Then verifies the squad came up and prints the org tree. The
# auto-provision hook only exists on the feat/myhive-board build — an older server
# creates an EMPTY company, which this script will catch and flag in step 2.
#
# A DB-direct script would bypass the route and miss auto-provision; that is why
# this talks to the API, not the database.
#
# Usage:
#   scripts/create-pilot-company.sh "Hive Pilot"
#   API_BASE=http://127.0.0.1:3100/api scripts/create-pilot-company.sh "Hive Pilot"
#   scripts/create-pilot-company.sh "Hive Pilot" \
#       --with-pilot "Pilot: add rate limiter" "Limit /api/upload to 10 req/min/user. AC: 429 over limit, unit test."
#
# Env:
#   API_BASE   API root (default http://127.0.0.1:3100/api). On a local instance you
#              are an implicit board/instance-admin, so no auth token is needed.
#   GATE_PROFILE  gate profile for --with-pilot (default dev_team; or light|solo|none).
#
set -euo pipefail

API_BASE="${API_BASE:-http://127.0.0.1:3100/api}"
GATE_PROFILE="${GATE_PROFILE:-dev_team}"
EXPECTED_AGENTS=6

NAME="${1:-}"
if [[ -z "$NAME" || "$NAME" == --* ]]; then
  echo "usage: $0 <company-name> [--with-pilot <title> <overview>]" >&2
  exit 2
fi
shift || true

WITH_PILOT=0
PILOT_TITLE=""
PILOT_OVERVIEW=""
if [[ "${1:-}" == "--with-pilot" ]]; then
  WITH_PILOT=1
  PILOT_TITLE="${2:-}"
  PILOT_OVERVIEW="${3:-}"
  if [[ -z "$PILOT_TITLE" ]]; then
    echo "--with-pilot needs a <title> (and optional <overview>)" >&2
    exit 2
  fi
fi

# Extract a top-level JSON property from stdin — node, no jq dependency.
prop() { node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));const v=d['$1'];if(v==null){process.exit(4)}process.stdout.write(String(v))"; }

echo "▶ API_BASE=$API_BASE"
echo "▶ Creating company \"$NAME\" …"

CREATE_JSON="$(curl -fsS -X POST "$API_BASE/companies" \
  -H 'Content-Type: application/json' \
  -d "$(node -e "process.stdout.write(JSON.stringify({name:process.argv[1]}))" "$NAME")")" || {
    echo "✗ create failed — is the server running on $API_BASE ?" >&2
    exit 1
  }

COMPANY_ID="$(printf '%s' "$CREATE_JSON" | prop id)"
echo "✓ company created: id=$COMPANY_ID"

echo "▶ Verifying auto-provisioned gate squad …"
AGENTS_JSON="$(curl -fsS "$API_BASE/companies/$COMPANY_ID/agents")"

# Print the org tree + capture count and the CTO id (ROOT = reportsTo null).
read -r AGENT_COUNT CTO_ID < <(printf '%s' "$AGENTS_JSON" | node -e '
  const a = JSON.parse(require("fs").readFileSync(0, "utf8"));
  let cto = "";
  const lines = a.map((x) => {
    const root = x.reportsTo == null;
    if (root && (x.role === "cto" || /cto/i.test(x.name))) cto = x.id;
    return "  " + x.name + " [" + x.role + "] -> " + (x.reportsTo ?? "ROOT");
  });
  // org tree to stderr (human), count+ctoId to stdout (machine)
  process.stderr.write(lines.join("\n") + "\n");
  process.stdout.write(a.length + " " + cto + "\n");
')

if [[ "${AGENT_COUNT:-0}" -lt "$EXPECTED_AGENTS" ]]; then
  echo "✗ expected $EXPECTED_AGENTS gate agents, found ${AGENT_COUNT:-0}." >&2
  echo "  Likely the server is NOT on the feat/myhive-board build, or auto-provision errored." >&2
  echo "  Check the server log for 'default team auto-provision failed', then recreate." >&2
  exit 1
fi
echo "✓ $AGENT_COUNT agents present (CTO id=$CTO_ID)"

if [[ "$WITH_PILOT" -eq 0 ]]; then
  cat <<EOF

Company is gate-ready.
  companyId = $COMPANY_ID
  ctoId     = $CTO_ID

Kick off a pilot:
  scripts/create-pilot-company.sh "$NAME" --with-pilot "<title>" "<overview>"
or by hand:
  POST $API_BASE/plans  {companyId,title,overview,gateProfile:"$GATE_PROFILE",assigneeAgentId:"$CTO_ID"}
  POST $API_BASE/plans/<planIssueId>/activate
EOF
  exit 0
fi

if [[ -z "$CTO_ID" ]]; then
  echo "✗ no root CTO found to assign the pilot plan to." >&2
  exit 1
fi

echo "▶ Creating pilot plan (gateProfile=$GATE_PROFILE) assigned to CTO …"
PLAN_JSON="$(curl -fsS -X POST "$API_BASE/plans" \
  -H 'Content-Type: application/json' \
  -d "$(node -e '
    const [companyId, title, overview, gateProfile, assigneeAgentId] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({ companyId, title, overview: overview || null, gateProfile, assigneeAgentId }));
  ' "$COMPANY_ID" "$PILOT_TITLE" "$PILOT_OVERVIEW" "$GATE_PROFILE" "$CTO_ID")")"

PLAN_ID="$(printf '%s' "$PLAN_JSON" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(d.issue.id)')"
echo "✓ plan created: issueId=$PLAN_ID"

echo "▶ Activating plan (wakes the architect) …"
curl -fsS -X POST "$API_BASE/plans/$PLAN_ID/activate" >/dev/null
echo "✓ plan activated."

cat <<EOF

Pilot is live.
  companyId   = $COMPANY_ID
  ctoId       = $CTO_ID
  planIssueId = $PLAN_ID

Watch the gate loop on the MyHive board. Stop with:
  POST $API_BASE/plans/$PLAN_ID/stop
EOF
