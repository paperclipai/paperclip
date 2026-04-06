#!/usr/bin/env bash
# =============================================================================
# demo-seed.sh — eMerge Demo Seed Data
# =============================================================================
#
# Creates the demo story for the Raava eMerge demo:
#   - Company: Mendez Logistics
#   - 5 AI agents with Raava roles
#   - 3-5 sample tasks
#   - 1 project: Project Alpha
#
# Idempotent: safe to run multiple times. Existing resources are skipped.
#
# Usage:
#   # In local_trusted mode (no auth required):
#   ./scripts/demo-seed.sh
#
#   # In fleetos mode (API key required):
#   ./scripts/demo-seed.sh <FLEETOS_API_KEY>
#   # or
#   FLEETOS_API_KEY=<key> ./scripts/demo-seed.sh
#
# Environment:
#   DASHBOARD_URL   — Base URL for the dashboard API (default: http://localhost:3100)
#   FLEETOS_API_KEY — FleetOS API key for authenticated mode (or pass as $1)
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:3100}"
API_BASE="${DASHBOARD_URL}/api"

# API key: first positional arg takes precedence over env var
API_KEY="${1:-${FLEETOS_API_KEY:-}}"

# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

# ---------------------------------------------------------------------------
# Counters
# ---------------------------------------------------------------------------
CREATED=0
SKIPPED=0
ERRORS=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log_create() { echo -e "  ${GREEN}+${NC} Created: $1"; CREATED=$((CREATED + 1)); }
log_skip()   { echo -e "  ${YELLOW}~${NC} Skipped: $1 (already exists)"; SKIPPED=$((SKIPPED + 1)); }
log_error()  { echo -e "  ${RED}!${NC} Error: $1"; ERRORS=$((ERRORS + 1)); }

header() {
  echo ""
  echo -e "${BOLD}$1${NC}"
}

# Build curl args with optional auth header
curl_args() {
  local args=(-sf --max-time 10)
  if [ -n "$API_KEY" ]; then
    args+=(-H "x-api-key: ${API_KEY}")
    args+=(-H "Origin: ${DASHBOARD_URL}")
  fi
  args+=(-H "Content-Type: application/json")
  echo "${args[@]}"
}

# Wrapper for API calls with error handling.
# Usage: api_post <endpoint> <json_body>
# Returns: response body on success, empty string on failure
api_post() {
  local endpoint="$1"
  local body="$2"
  local url="${API_BASE}${endpoint}"
  local response http_code

  # Use -w to capture HTTP code, -o for body
  local tmpfile
  tmpfile=$(mktemp)
  http_code=$(curl -s --max-time 10 \
    ${API_KEY:+-H "x-api-key: ${API_KEY}"} \
    ${API_KEY:+-H "Origin: ${DASHBOARD_URL}"} \
    -H "Content-Type: application/json" \
    -d "$body" \
    -w "%{http_code}" \
    -o "$tmpfile" \
    "$url" 2>/dev/null) || { rm -f "$tmpfile"; echo ""; return 1; }

  response=$(cat "$tmpfile")
  rm -f "$tmpfile"

  case "$http_code" in
    2[0-9][0-9]) echo "$response"; return 0 ;;
    409)         echo "CONFLICT"; return 0 ;;  # Already exists
    *)           echo ""; return 1 ;;
  esac
}

# Wrapper for API GET calls
api_get() {
  local endpoint="$1"
  local url="${API_BASE}${endpoint}"
  curl -sf --max-time 10 \
    ${API_KEY:+-H "x-api-key: ${API_KEY}"} \
    ${API_KEY:+-H "Origin: ${DASHBOARD_URL}"} \
    -H "Content-Type: application/json" \
    "$url" 2>/dev/null || echo ""
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
echo -e "${BOLD}Raava eMerge Demo — Seed Data${NC}"
echo "Target: ${API_BASE}"
if [ -n "$API_KEY" ]; then
  echo "Auth: FleetOS API key provided"
else
  echo "Auth: None (local_trusted mode)"
fi

# Quick health check
if ! curl -sf --max-time 3 "${API_BASE}/health" >/dev/null 2>&1; then
  echo -e "${RED}Error: Dashboard is not responding at ${API_BASE}/health${NC}"
  echo "Make sure the dashboard is running on the expected port."
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Create Company: Mendez Logistics
# ---------------------------------------------------------------------------
header "Company"

# Check if Mendez Logistics already exists
COMPANIES=$(api_get "/companies")
if echo "$COMPANIES" | grep -q '"Mendez Logistics"' 2>/dev/null; then
  log_skip "Company 'Mendez Logistics'"
  # Extract the Mendez Logistics company ID (find the id preceding "Mendez Logistics" in the JSON)
  COMPANY_ID=$(echo "$COMPANIES" | grep -oP '"id"\s*:\s*"[^"]*"[^}]*"Mendez Logistics"' | grep -oP '"id"\s*:\s*"\K[^"]*')
else
  RESULT=$(api_post "/companies" '{
    "name": "Mendez Logistics",
    "industry": "Logistics & Supply Chain",
    "description": "Mid-market logistics company specializing in last-mile delivery and warehouse operations across the Southwest US."
  }')

  if [ -z "$RESULT" ]; then
    log_error "Failed to create company 'Mendez Logistics'"
  elif [ "$RESULT" = "CONFLICT" ]; then
    log_skip "Company 'Mendez Logistics'"
  else
    log_create "Company 'Mendez Logistics'"
    COMPANY_ID=$(echo "$RESULT" | grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  fi
fi

# Fallback: re-fetch company ID if we don't have it yet
if [ -z "${COMPANY_ID:-}" ]; then
  COMPANIES=$(api_get "/companies")
  COMPANY_ID=$(echo "$COMPANIES" | grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
fi

if [ -z "${COMPANY_ID:-}" ]; then
  echo -e "${RED}Fatal: Could not determine company ID. Aborting.${NC}"
  exit 1
fi

echo "  Company ID: ${COMPANY_ID}"

# ---------------------------------------------------------------------------
# 2. Create Agents
# ---------------------------------------------------------------------------
header "Agents"

# Agent definitions: name|role|description
AGENTS=(
  "Alex|Sales Assistant|Manages lead tracking, follow-up scheduling, and CRM updates. Specializes in qualifying inbound leads and maintaining pipeline hygiene."
  "Jordan|Operations Manager|Oversees daily logistics operations, route optimization, and warehouse coordination. Monitors KPIs and flags bottlenecks."
  "Sam|Data Analyst|Generates reports, analyzes delivery performance metrics, and identifies cost-saving opportunities across the supply chain."
  "Taylor|Customer Support|Handles customer inquiries, shipment tracking requests, and escalation management. Maintains a 98% satisfaction target."
  "Riley|Marketing Coordinator|Plans and executes marketing campaigns, manages social media presence, and tracks lead attribution across channels."
)

for agent_def in "${AGENTS[@]}"; do
  IFS='|' read -r AGENT_NAME AGENT_ROLE AGENT_DESC <<< "$agent_def"

  # Check if agent already exists (search by name in the agents list)
  EXISTING_AGENTS=$(api_get "/companies/${COMPANY_ID}/agents")
  if echo "$EXISTING_AGENTS" | grep -q "\"${AGENT_NAME}\"" 2>/dev/null; then
    log_skip "Agent '${AGENT_NAME}' (${AGENT_ROLE})"
    continue
  fi

  RESULT=$(api_post "/companies/${COMPANY_ID}/agents" "{
    \"name\": \"${AGENT_NAME}\",
    \"title\": \"${AGENT_ROLE}\",
    \"capabilities\": \"${AGENT_DESC}\"
  }")

  if [ -z "$RESULT" ]; then
    log_error "Failed to create agent '${AGENT_NAME}'"
  elif [ "$RESULT" = "CONFLICT" ]; then
    log_skip "Agent '${AGENT_NAME}' (${AGENT_ROLE})"
  else
    log_create "Agent '${AGENT_NAME}' (${AGENT_ROLE})"
  fi
done

# ---------------------------------------------------------------------------
# 3. Create Issues (Tasks)
# ---------------------------------------------------------------------------
header "Issues"

# Issue definitions: title|description|status|priority
# Valid statuses: backlog, todo, in_progress, in_review, done
# Valid priorities: critical, high, medium, low
TASKS=(
  "Follow up on Q2 leads|Review and prioritize the 47 inbound leads from the Q2 trade show. Schedule follow-up calls for top 10 prospects.|todo|high"
  "Generate weekly KPI report|Compile delivery performance, on-time rates, and cost-per-mile metrics for the weekly ops review.|todo|medium"
  "Resolve Acme Corp shipping delay|Customer escalation: Acme Corp shipment #4821 delayed 3 days. Coordinate with warehouse team for expedited resolution.|todo|critical"
  "Draft Q3 marketing campaign|Create campaign brief for Q3 focused on new warehouse automation capabilities. Include social, email, and trade show strategy.|backlog|medium"
  "Audit driver route efficiency|Analyze last 30 days of route data to identify optimization opportunities. Target: 12% reduction in average delivery time.|backlog|low"
)

EXISTING_TASKS=$(api_get "/companies/${COMPANY_ID}/issues")

for task_def in "${TASKS[@]}"; do
  IFS='|' read -r TASK_TITLE TASK_DESC TASK_STATUS TASK_PRIORITY <<< "$task_def"

  if echo "$EXISTING_TASKS" | grep -q "$(echo "$TASK_TITLE" | head -c 30)" 2>/dev/null; then
    log_skip "Issue '${TASK_TITLE}'"
    continue
  fi

  RESULT=$(api_post "/companies/${COMPANY_ID}/issues" "{
    \"title\": \"${TASK_TITLE}\",
    \"description\": \"${TASK_DESC}\",
    \"status\": \"${TASK_STATUS}\",
    \"priority\": \"${TASK_PRIORITY}\"
  }")

  if [ -z "$RESULT" ]; then
    log_error "Failed to create issue '${TASK_TITLE}'"
  elif [ "$RESULT" = "CONFLICT" ]; then
    log_skip "Issue '${TASK_TITLE}'"
  else
    log_create "Issue '${TASK_TITLE}'"
  fi
done

# ---------------------------------------------------------------------------
# 4. Create Project
# ---------------------------------------------------------------------------
header "Projects"

EXISTING_PROJECTS=$(api_get "/companies/${COMPANY_ID}/projects")

if echo "$EXISTING_PROJECTS" | grep -q '"Project Alpha"' 2>/dev/null; then
  log_skip "Project 'Project Alpha'"
else
  RESULT=$(api_post "/companies/${COMPANY_ID}/projects" "{
    \"name\": \"Project Alpha\",
    \"description\": \"End-to-end automation of last-mile delivery operations. Phase 1 focuses on route optimization and real-time tracking integration.\",
    \"status\": \"in_progress\"
  }")

  if [ -z "$RESULT" ]; then
    log_error "Failed to create project 'Project Alpha'"
  elif [ "$RESULT" = "CONFLICT" ]; then
    log_skip "Project 'Project Alpha'"
  else
    log_create "Project 'Project Alpha'"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  ${GREEN}+ ${CREATED} created${NC}  ${YELLOW}~ ${SKIPPED} skipped${NC}  ${RED}! ${ERRORS} errors${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

if [ "$ERRORS" -gt 0 ]; then
  echo -e "  ${RED}Seeding completed with errors.${NC} Check output above."
  exit 1
else
  echo -e "  ${GREEN}Demo data is ready.${NC}"
  exit 0
fi
