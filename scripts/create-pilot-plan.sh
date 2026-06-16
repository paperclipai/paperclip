#!/usr/bin/env bash
#
# create-pilot-plan.sh — create a DRAFT pilot plan (with tier-1 tickets) against an
# existing gate-ready company (made by create-pilot-company.sh).
#
# The plan is created as a draft, assigned to the company's root CTO, and seeded
# with a first-tier ticket so it is immediately ACTIVATABLE later. It does NOT
# activate — that is a separate, deliberate step (see the printed command). Talks
# to the running server's HTTP API.
#
# Usage:
#   scripts/create-pilot-plan.sh <companyId> <profile> [title] [overview]
#
#   <profile>  light | full   (also accepts raw enum: solo | dev_team | none)
#                full  -> dev_team gate profile (plan + code + wiring gates)
#                light -> code-review gate only
#
# Omit title/overview to use a built-in sample task for that profile, so you can
# seed both lanes with just:
#   scripts/create-pilot-plan.sh <companyId> light
#   scripts/create-pilot-plan.sh <companyId> full
#
# Env:
#   API_BASE   API root (default http://127.0.0.1:3100/api).
#   ASSIGNEE   override the plan assignee agent id (default: the company's root CTO).
#
set -euo pipefail

API_BASE="${API_BASE:-http://127.0.0.1:3100/api}"

COMPANY_ID="${1:-}"
PROFILE_ARG="${2:-}"
TITLE="${3:-}"
OVERVIEW="${4:-}"

if [[ -z "$COMPANY_ID" || -z "$PROFILE_ARG" ]]; then
  echo "usage: $0 <companyId> <light|full> [title] [overview]" >&2
  exit 2
fi

# Map friendly profile -> gateProfile enum (none|solo|light|dev_team).
case "$PROFILE_ARG" in
  full|dev_team) GATE_PROFILE="dev_team" ;;
  light)         GATE_PROFILE="light" ;;
  solo)          GATE_PROFILE="solo" ;;
  none)          GATE_PROFILE="none" ;;
  *) echo "unknown profile '$PROFILE_ARG' (use light|full, or solo|dev_team|none)" >&2; exit 2 ;;
esac

# Built-in sample tasks per lane. 'light' stays small (code-review only); 'full'
# trips real plan+code+wiring gates on a high-risk path.
if [[ -z "$TITLE" ]]; then
  if [[ "$GATE_PROFILE" == "light" ]]; then
    TITLE="Pilot (light): add a /healthz alias route"
    OVERVIEW="Add a GET /healthz route returning the same JSON as /health. AC: 200 + {status:'ok'}, one unit test. Single small file; no auth, no migration."
    CHILD_TITLE="Add /healthz alias route + test"
    CHILD_DESC="Implement GET /healthz as an alias of /health; add a unit test asserting 200 and {status:'ok'}."
  else
    TITLE="Pilot (full): rate-limit the upload route"
    OVERVIEW="Add a per-user rate limiter to POST /api/upload — 10 req/min/user, 429 over the cap with Retry-After. AC: 429 past the limit, resets after the window, unit + integration tests. Touches a route + middleware (high-risk -> full gates)."
    CHILD_TITLE="Implement per-user upload rate limiter"
    CHILD_DESC="Add middleware limiting POST /api/upload to 10 req/min/user, returning 429 + Retry-After over the cap; cover with unit + integration tests."
  fi
fi
# Default child for an explicit title (so the plan is still activatable).
CHILD_TITLE="${CHILD_TITLE:-$TITLE}"
CHILD_DESC="${CHILD_DESC:-${OVERVIEW:-Implement the pilot task.}}"

# Resolve plan assignee: explicit ASSIGNEE, else the company's root CTO.
ASSIGNEE_ID="${ASSIGNEE:-}"
if [[ -z "$ASSIGNEE_ID" ]]; then
  AGENTS_JSON="$(curl -fsS "$API_BASE/companies/$COMPANY_ID/agents")"
  ASSIGNEE_ID="$(printf '%s' "$AGENTS_JSON" | node -e '
    const a = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const cto = a.find((x) => x.reportsTo == null && (x.role === "cto" || /cto/i.test(x.name)))
      || a.find((x) => x.reportsTo == null);
    process.stdout.write(cto ? cto.id : "");
  ')"
  if [[ -z "$ASSIGNEE_ID" ]]; then
    echo "✗ could not find a root CTO in company $COMPANY_ID — pass ASSIGNEE=<agentId>" >&2
    exit 1
  fi
fi

# Resolve the company's pilot project so child issues inherit the git_worktree
# isolation policy. Without projectId, issues have no project → no policy →
# agents use the main watched tree → process_detached on hot-reload (A4/G fix).
PROJECT_ID="${PROJECT_ID:-}"
if [[ -z "$PROJECT_ID" ]]; then
  PROJECTS_JSON="$(curl -fsS "$API_BASE/companies/$COMPANY_ID/projects")" || {
    echo "✗ could not list projects for company $COMPANY_ID (server unreachable or rejected the request)." >&2
    echo "  Refusing to create a plan blind to worktree isolation — fix the server, then retry." >&2
    exit 1
  }
  PROJECT_ID="$(printf '%s' "$PROJECTS_JSON" | node -e '
    try {
      const p = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const list = Array.isArray(p) ? p : (p.projects ?? []);
      // Prefer the named pilot project; fall back to the sole project for back-compat.
      const pilot = list.find((x) => x && x.name === "Pilot");
      // Warn when falling back by position (no "Pilot" match but other projects
      // exist) so a wrong-project selection is never silent (BUG-008 follow-up).
      if (!pilot && list[0]) {
        const picked = list[0].name ?? list[0].id;
        process.stderr.write(`warning: no project named "Pilot"; falling back to first project (${picked})\n`);
      }
      process.stdout.write((pilot ?? list[0])?.id ?? "");
    } catch (e) { process.stdout.write(""); }
  ')"
fi
if [[ -n "$PROJECT_ID" ]]; then
  echo "  projectId=$PROJECT_ID (worktree isolation active)"
else
  echo "  warning: company has no project — agents will use scratch dir, not a worktree." >&2
  echo "  Run create-pilot-company.sh first; it provisions the git_worktree project." >&2
fi

echo "▶ API_BASE=$API_BASE"
echo "▶ company=$COMPANY_ID  profile=$GATE_PROFILE  assignee=$ASSIGNEE_ID"
echo "▶ Creating DRAFT plan (with tier-1 ticket): $TITLE"

# Build the full create body: a single first-tier 'phase' carrying one requested
# child ticket — that ticket is what makes the plan activatable later
# (activate() rejects a plan whose first tier has no requestedChildren).
PLAN_JSON="$(curl -fsS -X POST "$API_BASE/plans" \
  -H 'Content-Type: application/json' \
  -d "$(node -e '
    const [companyId, title, overview, gateProfile, assigneeAgentId, childTitle, childDesc, projectId] = process.argv.slice(1);
    const body = {
      companyId, title, overview: overview || null, gateProfile, assigneeAgentId,
      tiers: [
        {
          id: "tier-1",
          kind: "phase",
          name: "Tier 1",
          requestedChildren: [
            { title: childTitle, description: childDesc, priority: "medium" },
          ],
          childIssueIds: [],
        },
      ],
    };
    if (projectId) body.projectId = projectId;
    process.stdout.write(JSON.stringify(body));
  ' "$COMPANY_ID" "$TITLE" "$OVERVIEW" "$GATE_PROFILE" "$ASSIGNEE_ID" "$CHILD_TITLE" "$CHILD_DESC" "${PROJECT_ID:-}")")" || {
    echo "✗ draft plan creation request failed (POST /plans was rejected)." >&2
    exit 1
  }

# Guard the id extraction so a server error body (no issue.id) prints the response
# instead of aborting under set -e with a bare node TypeError.
PLAN_ID="$(printf '%s' "$PLAN_JSON" | node -e '
  try {
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
    if (!d.issue || !d.issue.id) throw new Error("no issue.id");
    process.stdout.write(d.issue.id);
  } catch (e) { process.exit(7); }
')" || {
    echo "✗ draft plan creation returned an unexpected response (no issue.id)." >&2
    echo "  response: $PLAN_JSON" >&2
    exit 1
  }
EFFECTIVE="$(printf '%s' "$PLAN_JSON" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(String(d.planDetails && d.planDetails.gateProfile || ""))')"
STATE="$(printf '%s' "$PLAN_JSON" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(String(d.planDetails && d.planDetails.state || ""))')"

echo "✓ plan created: issueId=$PLAN_ID  state=${STATE:-?}  (requested=$GATE_PROFILE effective=${EFFECTIVE:-?})"
if [[ -n "$EFFECTIVE" && "$EFFECTIVE" != "$GATE_PROFILE" ]]; then
  echo "  note: Layer-0 triage floor raised the profile ($GATE_PROFILE → $EFFECTIVE)."
fi

cat <<EOF

Draft plan is ready to activate later.
  companyId   = $COMPANY_ID
  planIssueId = $PLAN_ID
  profile     = ${EFFECTIVE:-$GATE_PROFILE}

Activate when you want the gate loop to run (materializes the tier-1 child + wakes the architect):
  curl -fsS -X POST $API_BASE/plans/$PLAN_ID/activate
EOF
