#!/bin/bash
set -euo pipefail

API="http://localhost:3100/api"
LAB="${ADLUCY_LAB_PATH:-$HOME/lab}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_FILE="$SCRIPT_DIR/.adlucy-state.json"

# ── CLI flags ──
SKIP_PERMS=false
CLEAN=false
for arg in "$@"; do
  case "$arg" in
    --skip-permissions) SKIP_PERMS=true ;;
    --clean) CLEAN=true ;;
  esac
done

# ── State file helpers ──
load_state() {
  if [ -f "$STATE_FILE" ]; then
    cat "$STATE_FILE"
  else
    echo '{}'
  fi
}

save_state() {
  local tmp
  tmp=$(mktemp "$STATE_FILE.XXXXXX")
  echo "$1" > "$tmp"
  mv -f "$tmp" "$STATE_FILE"
}

entity_exists() {
  # Try single-entity GET first
  if curl -sf "$1" > /dev/null 2>&1; then
    return 0
  fi
  # Fall back to list lookup (some endpoints only support list)
  local list_url="${1%/*}"
  local entity_id="${1##*/}"
  curl -sf "$list_url" 2>/dev/null | jq -e --arg id "$entity_id" 'any(.[]; .id == $id)' > /dev/null 2>&1
}

# ── Handle --clean ──
if [ "$CLEAN" = true ]; then
  echo "→ Removing state file..."
  rm -f "$STATE_FILE"
  echo "  ✓ State cleared. Re-run without --clean to provision."
  exit 0
fi

echo "╔═══════════════════════════════════════════════╗"
echo "║   Ad-Lucy AI Control Center — Automated Setup ║"
echo "╚═══════════════════════════════════════════════╝"
echo ""

if [ "$SKIP_PERMS" = true ]; then
  echo "  Mode: --skip-permissions (agents will auto-start)"
else
  echo "  Mode: default (agents will be created but NOT started)"
fi
echo ""

STATE=$(load_state)

# ── 1. Health check ──
echo "→ Checking Paperclip health..."
if ! curl -sf "$API/health" > /dev/null 2>&1; then
  echo "✗ Paperclip not running. Start with: pnpm dev"
  exit 1
fi
echo "  ✓ Paperclip is running"

# ── 2. Install knowledge base plugin ──
echo ""
echo "→ Installing Ad-Lucy Knowledge Base plugin..."
PLUGIN_PATH="$SCRIPT_DIR/../packages/plugins/examples/plugin-adlucy-kb"
if ! curl -sf -X POST "$API/plugins/install" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg p "$PLUGIN_PATH" '{packageName: $p, isLocalPath: true}')" > /dev/null; then
  echo "  ⚠ Plugin install returned error (may already be installed)"
else
  echo "  ✓ Plugin installed"
fi

# Wait briefly for plugin to initialize
sleep 2

# Configure plugin labPath
echo "→ Configuring plugin labPath..."
if curl -sf -X POST "$API/plugins/paperclipai.adlucy-kb/config" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg p "$LAB" '{configJson: {labPath: $p}}')" > /dev/null 2>&1; then
  echo "  ✓ Plugin labPath configured"
else
  echo "  ⚠ Plugin config update failed (plugin may not be ready yet)"
fi

# ── 3. Create company ──
echo ""
echo "→ Creating Ad-Lucy company..."
COMPANY_ID=$(echo "$STATE" | jq -r '.companyId // empty')
if [ -n "$COMPANY_ID" ] && entity_exists "$API/companies/$COMPANY_ID"; then
  echo "  ↺ Reusing company: $COMPANY_ID"
else
  COMPANY_RESPONSE=$(curl -sf -X POST "$API/companies" \
    -H "Content-Type: application/json" \
    -d "$(jq -n '{
      name: "Ad-Lucy",
      description: "Factor Eleven ad-tech platform — 30+ microservices for programmatic advertising",
      budgetMonthlyCents: 50000
    }')")
  COMPANY_ID=$(echo "$COMPANY_RESPONSE" | jq -r '.id')
  STATE=$(echo "$STATE" | jq --arg id "$COMPANY_ID" '.companyId = $id')
  echo "  ✓ Company: $COMPANY_ID"
fi

# ── 4. Create mission goal ──
echo ""
echo "→ Creating mission goal..."
MISSION_ID=$(echo "$STATE" | jq -r '.missionId // empty')
if [ -n "$MISSION_ID" ] && entity_exists "$API/companies/$COMPANY_ID/goals/$MISSION_ID"; then
  echo "  ↺ Reusing goal: $MISSION_ID"
else
  MISSION_RESPONSE=$(curl -sf -X POST "$API/companies/$COMPANY_ID/goals" \
    -H "Content-Type: application/json" \
    -d "$(jq -n '{
      title: "Maintain code quality, security, and architectural coherence across the Ad-Lucy polyrepo",
      level: "company",
      status: "active"
    }')")
  MISSION_ID=$(echo "$MISSION_RESPONSE" | jq -r '.id')
  STATE=$(echo "$STATE" | jq --arg id "$MISSION_ID" '.missionId = $id')
  echo "  ✓ Goal: $MISSION_ID"
fi

# ── 5. Create projects ──
echo ""
echo "→ Creating projects..."

create_project() {
  local key="$1" name="$2" desc="$3" cwd="$4"
  local existing_id
  existing_id=$(echo "$STATE" | jq -r --arg k "$key" '.projects[$k] // empty')
  if [ -n "$existing_id" ] && entity_exists "$API/companies/$COMPANY_ID/projects/$existing_id"; then
    echo "  ↺ Reusing project $name: $existing_id"
    eval "PROJ_${key}=$existing_id"
    return
  fi
  local resp
  resp=$(curl -sf -X POST "$API/companies/$COMPANY_ID/projects" \
    -H "Content-Type: application/json" \
    -d "$(jq -n \
      --arg name "$name" \
      --arg desc "$desc" \
      --arg cwd "$cwd" \
      --arg goalId "$MISSION_ID" \
      '{name: $name, description: $desc, status: "in_progress", goalIds: [$goalId], workspace: {cwd: $cwd, isPrimary: true}}'
    )")
  local pid
  pid=$(echo "$resp" | jq -r '.id')
  STATE=$(echo "$STATE" | jq --arg k "$key" --arg id "$pid" '.projects[$k] = $id')
  eval "PROJ_${key}=$pid"
  echo "  ✓ Project $name: $pid"
}

create_project "API" "api" \
  "Main backend — Apollo GraphQL, Express, TypeORM, MySQL" \
  "$LAB/api"

create_project "CC" "controlcenter-api" \
  "REST + GraphQL API for client management and bookings" \
  "$LAB/controlcenter-api"

create_project "ECO" "ad-lucy-ecosystem" \
  "Cross-repo architecture and knowledge — root of all 30+ repos" \
  "$LAB"

# ── 6. Create agents ──
echo ""
echo "→ Creating agents..."

create_agent() {
  local key="$1" name="$2" title="$3" icon="$4" caps="$5" turns="$6" budget="$7" instructions="$8"
  local existing_id
  existing_id=$(echo "$STATE" | jq -r --arg k "$key" '.agents[$k] // empty')
  if [ -n "$existing_id" ] && entity_exists "$API/companies/$COMPANY_ID/agents/$existing_id"; then
    echo "  ↺ Reusing agent $name ($title): $existing_id"
    eval "AGENT_${key}=$existing_id"
    return
  fi

  local adapter_config
  if [ "$SKIP_PERMS" = true ]; then
    adapter_config=$(jq -n \
      --arg model "claude-sonnet-4-6" \
      --argjson turns "$turns" \
      --arg inst "$instructions" \
      '{model: $model, maxTurnsPerRun: $turns, dangerouslySkipPermissions: true, instructionsFilePath: $inst}')
  else
    adapter_config=$(jq -n \
      --arg model "claude-sonnet-4-6" \
      --argjson turns "$turns" \
      --arg inst "$instructions" \
      '{model: $model, maxTurnsPerRun: $turns, instructionsFilePath: $inst}')
  fi

  local resp
  resp=$(curl -sf -X POST "$API/companies/$COMPANY_ID/agents" \
    -H "Content-Type: application/json" \
    -d "$(jq -n \
      --arg name "$name" \
      --arg title "$title" \
      --arg icon "$icon" \
      --arg caps "$caps" \
      --argjson budget "$budget" \
      --argjson adapterConfig "$adapter_config" \
      '{name: $name, role: "engineer", title: $title, icon: $icon, capabilities: $caps, adapterType: "claude_local", adapterConfig: $adapterConfig, budgetMonthlyCents: $budget}'
    )")
  local aid
  aid=$(echo "$resp" | jq -r '.id')
  STATE=$(echo "$STATE" | jq --arg k "$key" --arg id "$aid" '.agents[$k] = $id')
  eval "AGENT_${key}=$aid"
  echo "  ✓ Agent $name ($title): $aid"
}

create_agent "LUCY" "Lucy" "Architecture Advisor" "telescope" \
  "Cross-repo architecture analysis, data flow tracing, ecosystem documentation" \
  30 20000 "$SCRIPT_DIR/agent-instructions/lucy-architect.md"

create_agent "REX" "Rex" "Code Reviewer" "search" \
  "Code review, bug detection, performance analysis, best practices" \
  20 15000 "$SCRIPT_DIR/agent-instructions/rex-reviewer.md"

create_agent "SHIELD" "Shield" "Security Scanner" "shield" \
  "OWASP Top 10 scanning, injection detection, auth analysis, secret exposure" \
  25 15000 "$SCRIPT_DIR/agent-instructions/shield-security.md"

# ── 7. Create issues and assign to agents ──
echo ""
echo "→ Creating issues..."

ISSUES_CREATED=$(echo "$STATE" | jq -r '.issuesCreated // empty')
if [ "$ISSUES_CREATED" = "true" ]; then
  echo "  ↺ Issues already created (skipping)"
else
  curl -sf -X POST "$API/companies/$COMPANY_ID/issues" \
    -H "Content-Type: application/json" \
    -d "$(jq -n \
      --arg projId "$PROJ_ECO" \
      --arg goalId "$MISSION_ID" \
      --arg agentId "$AGENT_LUCY" \
      '{
        title: "Document the ad impression → reporting KPI data flow",
        description: "Trace how an ad impression event flows through: adserver → tracking-reporting → aerospike-proxy → reporting-api → analytics-service. Use the knowledge base tool to pull architectural docs for each service. Produce a markdown document with a data flow diagram.",
        status: "todo",
        priority: "high",
        projectId: $projId,
        goalId: $goalId,
        assigneeAgentId: $agentId
      }')" > /dev/null
  echo "  ✓ Issue: Document ad impression data flow → Lucy"

  curl -sf -X POST "$API/companies/$COMPANY_ID/issues" \
    -H "Content-Type: application/json" \
    -d "$(jq -n \
      --arg projId "$PROJ_CC" \
      --arg goalId "$MISSION_ID" \
      --arg agentId "$AGENT_SHIELD" \
      '{
        title: "Review controlcenter-api auth middleware for security issues",
        description: "Focus on JWT handling, session management, input validation. Check for OWASP Top 10 vulnerabilities. Use the knowledge base tool to understand the service architecture first.",
        status: "todo",
        priority: "high",
        projectId: $projId,
        goalId: $goalId,
        assigneeAgentId: $agentId
      }')" > /dev/null
  echo "  ✓ Issue: Security review auth middleware → Shield"

  curl -sf -X POST "$API/companies/$COMPANY_ID/issues" \
    -H "Content-Type: application/json" \
    -d "$(jq -n \
      --arg projId "$PROJ_API" \
      --arg goalId "$MISSION_ID" \
      --arg agentId "$AGENT_REX" \
      '{
        title: "Review api service for test coverage gaps",
        description: "Analyze the api service test suite. Identify untested code paths, missing edge cases, and critical business logic without tests. Suggest specific test cases to add.",
        status: "todo",
        priority: "medium",
        projectId: $projId,
        goalId: $goalId,
        assigneeAgentId: $agentId
      }')" > /dev/null
  echo "  ✓ Issue: Review test coverage gaps → Rex"

  curl -sf -X POST "$API/companies/$COMPANY_ID/issues" \
    -H "Content-Type: application/json" \
    -d "$(jq -n \
      --arg projId "$PROJ_ECO" \
      --arg goalId "$MISSION_ID" \
      --arg agentId "$AGENT_LUCY" \
      '{
        title: "Analyze GraphQL federation schema consistency across subgraphs",
        description: "Check that ad-manager-gateway, api, controlcenter-api, campaign-optimization-service, and analytics-service have consistent GraphQL types and no conflicting field definitions. Use knowledge base to understand each subgraph.",
        status: "todo",
        priority: "medium",
        projectId: $projId,
        goalId: $goalId,
        assigneeAgentId: $agentId
      }')" > /dev/null
  echo "  ✓ Issue: Analyze GraphQL federation consistency → Lucy"

  STATE=$(echo "$STATE" | jq '.issuesCreated = true')
fi

# ── 8. Conditionally trigger agent wakeups ──
echo ""
if [ "$SKIP_PERMS" = true ]; then
  echo "→ Triggering agent runs (--skip-permissions mode)..."
  for AGENT_NAME_ID in "Lucy:$AGENT_LUCY" "Rex:$AGENT_REX" "Shield:$AGENT_SHIELD"; do
    AGENT_NAME="${AGENT_NAME_ID%%:*}"
    AGENT_ID="${AGENT_NAME_ID##*:}"
    if curl -sf -X POST "$API/agents/$AGENT_ID/wakeup" \
      -H "Content-Type: application/json" \
      -d '{"source":"on_demand","reason":"Initial prototype run"}' > /dev/null 2>&1; then
      echo "  ✓ Wakeup sent to $AGENT_NAME"
    else
      echo "  ⚠ Wakeup failed for $AGENT_NAME (agent may need adapter setup)"
    fi
  done
else
  echo "→ Agents created but NOT started."
  echo "  Run with --skip-permissions to auto-start, or use the dashboard."
  echo ""
  echo "  Manual wakeup examples:"
  echo "    curl -X POST \"$API/agents/$AGENT_LUCY/wakeup\" -H 'Content-Type: application/json' -d '{\"source\":\"on_demand\"}'"
  echo "    curl -X POST \"$API/agents/$AGENT_REX/wakeup\" -H 'Content-Type: application/json' -d '{\"source\":\"on_demand\"}'"
  echo "    curl -X POST \"$API/agents/$AGENT_SHIELD/wakeup\" -H 'Content-Type: application/json' -d '{\"source\":\"on_demand\"}'"
fi

# ── 9. Save state ──
save_state "$STATE"

# ── 10. Verification ──
echo ""
echo "→ Verifying setup..."

PLUGIN_STATUS=$(curl -sf "$API/plugins" 2>/dev/null | jq -r '.[] | select(.id | contains("adlucy-kb")) | .status' 2>/dev/null || echo "unknown")
echo "  Plugin status: $PLUGIN_STATUS"

AGENT_COUNT=$(curl -sf "$API/companies/$COMPANY_ID/agents" 2>/dev/null | jq 'length' 2>/dev/null || echo "?")
echo "  Agents created: $AGENT_COUNT"

ISSUE_COUNT=$(curl -sf "$API/companies/$COMPANY_ID/issues" 2>/dev/null | jq 'length' 2>/dev/null || echo "?")
echo "  Issues created: $ISSUE_COUNT"

# ── 11. Output summary ──
echo ""
echo "╔═══════════════════════════════════════════════╗"
echo "║   Ad-Lucy AI Control Center — Setup Complete   ║"
echo "╚═══════════════════════════════════════════════╝"
echo ""
echo "Company:  Ad-Lucy ($COMPANY_ID)"
echo "Goal:     $MISSION_ID"
echo ""
echo "Projects:"
echo "  api:               $PROJ_API"
echo "  controlcenter-api: $PROJ_CC"
echo "  ecosystem:         $PROJ_ECO"
echo ""
echo "Agents:"
echo "  Lucy (Architect):  $AGENT_LUCY"
echo "  Rex (Reviewer):    $AGENT_REX"
echo "  Shield (Security): $AGENT_SHIELD"
echo ""
echo "Dashboard: http://localhost:5173"
echo ""
if [ "$SKIP_PERMS" = true ]; then
  echo "Agents have been triggered. Check the dashboard for live progress."
else
  echo "Agents are provisioned but NOT running. Use --skip-permissions to auto-start."
fi
