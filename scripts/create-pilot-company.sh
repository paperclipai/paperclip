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

# ---------------------------------------------------------------------------
# 3. Create a project with git_worktree isolation policy so implementor runs
#    land in .paperclip/worktrees/<branch>/ — a checkout the dev server does
#    NOT watch (tsx watch runs from server/ and only sees server/src/).
#    Without this, implementors edit the main watched tree, trigger a hot-
#    reload, their process detaches (process_detached), and the run is lost.
# ---------------------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "▶ Creating pilot project with git_worktree isolation (repo=$REPO_ROOT)…"

# The project's workspace cwd is $REPO_ROOT — a path on THIS machine. It only
# resolves if the server shares this filesystem. Warn when API_BASE is remote.
case "$API_BASE" in
  *127.0.0.1*|*localhost*) ;;
  *)
    echo "  warning: API_BASE ($API_BASE) is not local — the worktree cwd '$REPO_ROOT'" >&2
    echo "  must exist on the SERVER's filesystem, or worktree provisioning will fail." >&2
    ;;
esac

# Check if company already has the pilot project (idempotent on re-run). Match by
# name so a pre-existing unrelated project is never wired in by accident (picking
# list[0] blindly could select the wrong project).
EXISTING_PROJECTS="$(curl -fsS "$API_BASE/companies/$COMPANY_ID/projects")" || {
  echo "✗ could not list existing projects for company $COMPANY_ID (server unreachable or rejected)." >&2
  exit 1
}
PROJECT_ID="$(printf '%s' "$EXISTING_PROJECTS" | node -e '
  try {
    const p = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const list = Array.isArray(p) ? p : (p.projects ?? []);
    const pilot = list.find((x) => x && x.name === "Pilot") ?? null;
    process.stdout.write(pilot?.id ?? "");
  } catch (e) { process.stdout.write(""); }
')"

if [[ -n "$PROJECT_ID" ]]; then
  echo "  project already exists: $PROJECT_ID (reusing)"
else
  PROJECT_JSON="$(curl -fsS -X POST "$API_BASE/companies/$COMPANY_ID/projects" \
    -H 'Content-Type: application/json' \
    -d "$(node -e '
      const [repoRoot] = process.argv.slice(1);
      process.stdout.write(JSON.stringify({
        name: "Pilot",
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "isolated_workspace",
          workspaceStrategy: { type: "git_worktree" },
        },
        workspace: {
          sourceType: "local_path",
          cwd: repoRoot,
          isPrimary: true,
        },
      }));
    ' "$REPO_ROOT")")" || {
      echo "✗ pilot project creation request failed (POST /projects rejected by the server)." >&2
      echo "  Refusing to continue: without git_worktree isolation, implementor runs edit the" >&2
      echo "  watched tree, hot-reload detaches the process (process_detached), and the run is lost." >&2
      exit 1
    }
  PROJECT_ID="$(printf '%s' "$PROJECT_JSON" | node -e '
    try {
      const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
      process.stdout.write(d.id ?? d.project?.id ?? "");
    } catch (e) { process.stdout.write(""); }
  ')"
  if [[ -z "$PROJECT_ID" ]]; then
    echo "✗ pilot project creation returned no id — worktree isolation would be silently absent." >&2
    echo "  response: $PROJECT_JSON" >&2
    exit 1
  fi
  echo "  project created: $PROJECT_ID"
fi

if [[ "$WITH_PILOT" -eq 0 ]]; then
  cat <<EOF

Company is gate-ready.
  companyId = $COMPANY_ID
  ctoId     = $CTO_ID
  projectId = ${PROJECT_ID:-(none)}

Kick off a pilot:
  scripts/create-pilot-company.sh "$NAME" --with-pilot "<title>" "<overview>"
or by hand:
  POST $API_BASE/plans  {companyId,projectId:"${PROJECT_ID:-null}",title,overview,gateProfile:"$GATE_PROFILE",assigneeAgentId:"$CTO_ID"}
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
    const [companyId, title, overview, gateProfile, assigneeAgentId, projectId] = process.argv.slice(1);
    const body = { companyId, title, overview: overview || null, gateProfile, assigneeAgentId };
    if (projectId) body.projectId = projectId;
    process.stdout.write(JSON.stringify(body));
  ' "$COMPANY_ID" "$PILOT_TITLE" "$PILOT_OVERVIEW" "$GATE_PROFILE" "$CTO_ID" "${PROJECT_ID:-}")")" || {
    echo "✗ pilot plan creation request failed (POST /plans was rejected)." >&2
    exit 1
  }

# Guard the id extraction: a server error body has no issue.id, and an unguarded
# d.issue.id throws — which under set -e would abort with a node stack and never
# show the server's error. Print the raw response instead.
PLAN_ID="$(printf '%s' "$PLAN_JSON" | node -e '
  try {
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
    if (!d.issue || !d.issue.id) throw new Error("no issue.id");
    process.stdout.write(d.issue.id);
  } catch (e) { process.exit(7); }
')" || {
    echo "✗ pilot plan creation returned an unexpected response (no issue.id)." >&2
    echo "  response: $PLAN_JSON" >&2
    exit 1
  }
echo "✓ plan created: issueId=$PLAN_ID"

echo "▶ Activating plan (wakes the architect) …"
curl -fsS -X POST "$API_BASE/plans/$PLAN_ID/activate" >/dev/null || {
  echo "✗ activate failed — plan $PLAN_ID was created but is still DRAFT." >&2
  echo "  activate it manually: curl -fsS -X POST $API_BASE/plans/$PLAN_ID/activate" >&2
  exit 1
}
echo "✓ plan activated."

cat <<EOF

Pilot is live.
  companyId   = $COMPANY_ID
  ctoId       = $CTO_ID
  planIssueId = $PLAN_ID

Watch the gate loop on the MyHive board. Stop with:
  POST $API_BASE/plans/$PLAN_ID/stop
EOF
