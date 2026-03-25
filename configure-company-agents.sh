#!/usr/bin/env bash
# configure-company-agents.sh
# Bulk-configure all agents in a Paperclip company with an adapter.
#
# Usage:
#   ./configure-company-agents.sh                    # interactive (pick company + adapter)
#   ./configure-company-agents.sh <company_id>       # pick adapter interactively
#   ./configure-company-agents.sh <company_id> claude # use claude_local preset
#   ./configure-company-agents.sh <company_id> openclaw
#   ./configure-company-agents.sh <company_id> process "python3 /path/to/agent.py"

set -euo pipefail

API="http://localhost:3100/api"

# ── Colors ──
RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERR]${NC} $*" >&2; }

# ── Health check ──
if ! curl -sf "$API/health" > /dev/null 2>&1; then
  err "Paperclip server not reachable at $API"
  err "Start it first: cd ~/paperclip && pnpm --filter server dev"
  exit 1
fi

# ── Step 1: Pick company ──
if [[ -n "${1:-}" ]]; then
  COMPANY_ID="$1"
  COMPANY_NAME=$(curl -sf "$API/companies/$COMPANY_ID" | jq -r '.name // "unknown"')
else
  info "Fetching companies..."
  COMPANIES=$(curl -sf "$API/companies" | jq -r '.[] | "\(.id)\t\(.name)\t\(.agentCount // "?")"')

  echo ""
  echo -e "${CYAN}  #  ID                                    Company                    Agents${NC}"
  echo "  ── ──────────────────────────────────── ────────────────────────── ──────"
  i=1
  declare -a COMPANY_IDS=()
  while IFS=$'\t' read -r cid cname ccount; do
    printf "  %-3d %-40s %-26s %s\n" "$i" "$cid" "$cname" "$ccount"
    COMPANY_IDS+=("$cid")
    i=$((i + 1))
  done <<< "$COMPANIES"

  echo ""
  read -rp "Pick a company (number): " PICK
  COMPANY_ID="${COMPANY_IDS[$((PICK - 1))]}"
  COMPANY_NAME=$(echo "$COMPANIES" | sed -n "${PICK}p" | cut -f2)
fi

info "Selected: ${YELLOW}$COMPANY_NAME${NC} ($COMPANY_ID)"

# ── Step 2: Fetch agents ──
AGENTS_JSON=$(curl -sf "$API/companies/$COMPANY_ID/agents")
AGENT_COUNT=$(echo "$AGENTS_JSON" | jq 'length')
info "Found ${YELLOW}$AGENT_COUNT${NC} agents"

if [[ "$AGENT_COUNT" -eq 0 ]]; then
  warn "No agents in this company. Nothing to configure."
  exit 0
fi

# ── Step 3: Pick adapter preset ──
ADAPTER_TYPE=""
ADAPTER_CONFIG=""

build_claude_config() {
  local model="${1:-claude-sonnet-4-6}"
  local cwd="${2:-$HOME/paperclip}"
  local timeout="${3:-300}"
  local max_turns="${4:-50}"

  ADAPTER_TYPE="claude_local"
  ADAPTER_CONFIG=$(jq -n \
    --arg cwd "$cwd" \
    --arg model "$model" \
    --argjson timeout "$timeout" \
    --argjson maxTurns "$max_turns" \
    '{
      cwd: $cwd,
      model: $model,
      timeoutSec: $timeout,
      maxTurnsPerRun: $maxTurns
    }')
}

build_openclaw_config() {
  local url="${1:-ws://localhost:3200}"
  local timeout="${2:-300}"

  ADAPTER_TYPE="openclaw_gateway"
  ADAPTER_CONFIG=$(jq -n \
    --arg url "$url" \
    --argjson timeout "$timeout" \
    '{
      url: $url,
      timeoutSec: $timeout,
      role: "operator",
      scopes: ["operator.admin"]
    }')
}

build_process_config() {
  local command="$1"
  local cwd="${2:-$HOME/paperclip}"
  local timeout="${3:-300}"

  ADAPTER_TYPE="process"
  ADAPTER_CONFIG=$(jq -n \
    --arg cmd "$command" \
    --arg cwd "$cwd" \
    --argjson timeout "$timeout" \
    '{
      command: $cmd,
      cwd: $cwd,
      timeoutSec: $timeout
    }')
}

PRESET="${2:-}"
case "$PRESET" in
  claude)
    build_claude_config "${3:-claude-sonnet-4-6}" "${4:-$HOME/paperclip}"
    ;;
  openclaw)
    build_openclaw_config "${3:-ws://localhost:3200}"
    ;;
  process)
    if [[ -z "${3:-}" ]]; then
      err "process adapter requires a command argument"
      err "Usage: $0 <company_id> process \"python3 /path/to/script.py\""
      exit 1
    fi
    build_process_config "$3"
    ;;
  "")
    echo ""
    echo -e "${CYAN}Adapter Presets:${NC}"
    echo "  1) claude_local   — Claude Code CLI (default: sonnet-4-6)"
    echo "  2) openclaw_gateway — Route through OpenClaw"
    echo "  3) process        — Run a shell command"
    echo ""
    read -rp "Pick adapter (1-3): " ADAPTER_PICK

    case "$ADAPTER_PICK" in
      1)
        read -rp "Model [claude-sonnet-4-6]: " MODEL
        read -rp "Working dir [$HOME/paperclip]: " CWD
        read -rp "Timeout secs [300]: " TIMEOUT
        read -rp "Max turns/run [50]: " TURNS
        build_claude_config "${MODEL:-claude-sonnet-4-6}" "${CWD:-$HOME/paperclip}" "${TIMEOUT:-300}" "${TURNS:-50}"
        ;;
      2)
        read -rp "WebSocket URL [ws://localhost:3200]: " URL
        build_openclaw_config "${URL:-ws://localhost:3200}"
        ;;
      3)
        read -rp "Shell command: " CMD
        build_process_config "$CMD"
        ;;
      *)
        err "Invalid choice"; exit 1
        ;;
    esac
    ;;
  *)
    err "Unknown preset: $PRESET (use: claude, openclaw, process)"
    exit 1
    ;;
esac

info "Adapter: ${YELLOW}$ADAPTER_TYPE${NC}"
echo "$ADAPTER_CONFIG" | jq .

# ── Step 4: Confirm ──
echo ""
warn "This will configure ALL $AGENT_COUNT agents in '$COMPANY_NAME' with $ADAPTER_TYPE"
read -rp "Continue? (y/N): " CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
  info "Aborted."
  exit 0
fi

# ── Step 5: Bulk patch ──
PAYLOAD=$(jq -n \
  --arg type "$ADAPTER_TYPE" \
  --argjson config "$ADAPTER_CONFIG" \
  '{
    adapterType: $type,
    adapterConfig: $config,
    replaceAdapterConfig: true
  }')

SUCCESS=0
FAILED=0

echo "$AGENTS_JSON" | jq -r '.[].id' | while read -r AGENT_ID; do
  AGENT_NAME=$(echo "$AGENTS_JSON" | jq -r --arg id "$AGENT_ID" '.[] | select(.id == $id) | .name')

  HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" \
    -X PATCH "$API/agents/$AGENT_ID" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" 2>/dev/null || echo "000")

  if [[ "$HTTP_CODE" == "200" ]]; then
    ok "  ✓ $AGENT_NAME"
  else
    err "  ✗ $AGENT_NAME (HTTP $HTTP_CODE)"
  fi
done

echo ""
ok "Done. Configured $AGENT_COUNT agents in '$COMPANY_NAME' → $ADAPTER_TYPE"

# ── Optional: trigger heartbeats ──
echo ""
read -rp "Trigger a heartbeat on all agents now? (y/N): " TRIGGER
if [[ "$TRIGGER" == "y" || "$TRIGGER" == "Y" ]]; then
  info "Invoking heartbeats..."
  echo "$AGENTS_JSON" | jq -r '.[].id' | while read -r AGENT_ID; do
    AGENT_NAME=$(echo "$AGENTS_JSON" | jq -r --arg id "$AGENT_ID" '.[] | select(.id == $id) | .name')
    curl -sf -X POST "$API/agents/$AGENT_ID/heartbeat/invoke" > /dev/null 2>&1 && \
      ok "  ↻ $AGENT_NAME" || \
      warn "  ↻ $AGENT_NAME (no heartbeat endpoint or failed)"
  done
  ok "Heartbeats sent."
fi
