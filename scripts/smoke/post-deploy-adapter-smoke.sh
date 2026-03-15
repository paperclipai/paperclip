#!/usr/bin/env bash
# Post-deploy smoke test for agent adapters.
#
# Fires a heartbeat run for one agent of each adapter type and confirms it
# reaches "running" status within a timeout.  This would have caught the
# HOME-override incident (DLD-155) before production impact.
#
# Usage:
#   PAPERCLIP_AUTH_HEADER="Bearer <token>" ./scripts/smoke/post-deploy-adapter-smoke.sh
#
# Environment variables:
#   PAPERCLIP_API_URL           – API base (default http://127.0.0.1:3100)
#   PAPERCLIP_AUTH_HEADER       – Authorization header value (required)
#   PAPERCLIP_COOKIE            – Alternative: cookie-based auth
#   COMPANY_ID                  – Target company ID (auto-detected if omitted)
#   ADAPTER_TYPES               – Comma-separated adapter types to test
#                                  (default: claude_local,codex_local,opencode_local,
#                                   cursor,gemini_local,pi_local)
#   RUN_REACH_RUNNING_TIMEOUT   – Seconds to wait for "running" status (default 120)
#   CANCEL_AFTER_RUNNING        – If "1", cancel run once "running" confirmed (default 1)
#   SMOKE_DIAG_DIR              – Directory for diagnostic output

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
SCRIPT_NAME="post-deploy-adapter-smoke"

log()  { echo "[$SCRIPT_NAME] $*"; }
warn() { echo "[$SCRIPT_NAME] WARN: $*" >&2; }
fail() { echo "[$SCRIPT_NAME] ERROR: $*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

require_cmd curl
require_cmd jq

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
PAPERCLIP_API_URL="${PAPERCLIP_API_URL:-http://127.0.0.1:3100}"
API_BASE="${PAPERCLIP_API_URL%/}/api"

ADAPTER_TYPES="${ADAPTER_TYPES:-claude_local,codex_local,opencode_local,cursor,gemini_local,pi_local}"
IFS=',' read -ra ADAPTER_LIST <<< "$ADAPTER_TYPES"

RUN_REACH_RUNNING_TIMEOUT="${RUN_REACH_RUNNING_TIMEOUT:-120}"
CANCEL_AFTER_RUNNING="${CANCEL_AFTER_RUNNING:-1}"
SMOKE_DIAG_DIR="${SMOKE_DIAG_DIR:-/tmp/$SCRIPT_NAME-diag-$(date +%Y%m%d-%H%M%S)}"

mkdir -p "$SMOKE_DIAG_DIR"

# Auth headers
AUTH_HEADERS=()
if [[ -n "${PAPERCLIP_AUTH_HEADER:-}" ]]; then
  AUTH_HEADERS+=( -H "Authorization: ${PAPERCLIP_AUTH_HEADER}" )
fi
if [[ -n "${PAPERCLIP_COOKIE:-}" ]]; then
  AUTH_HEADERS+=( -H "Cookie: ${PAPERCLIP_COOKIE}" )
  PAPERCLIP_BROWSER_ORIGIN="${PAPERCLIP_BROWSER_ORIGIN:-${PAPERCLIP_API_URL%/}}"
  AUTH_HEADERS+=( -H "Origin: ${PAPERCLIP_BROWSER_ORIGIN}" -H "Referer: ${PAPERCLIP_BROWSER_ORIGIN}/" )
fi

if [[ ${#AUTH_HEADERS[@]} -eq 0 ]]; then
  fail "Set PAPERCLIP_AUTH_HEADER or PAPERCLIP_COOKIE for authentication"
fi

# ---------------------------------------------------------------------------
# API helper
# ---------------------------------------------------------------------------
RESPONSE_CODE=""
RESPONSE_BODY=""

api_request() {
  local method="$1" path="$2" data="${3-}"
  local tmp url
  tmp="$(mktemp)"

  if [[ "$path" == http://* || "$path" == https://* ]]; then
    url="$path"
  elif [[ "$path" == /api/* ]]; then
    url="${PAPERCLIP_API_URL%/}${path}"
  else
    url="${API_BASE}${path}"
  fi

  local curl_args=( -s -w "\n%{http_code}" -X "$method" "${AUTH_HEADERS[@]}" )
  if [[ -n "$data" ]]; then
    curl_args+=( -H "Content-Type: application/json" -d "$data" )
  fi
  curl_args+=( "$url" )

  local raw
  raw="$(curl "${curl_args[@]}" 2>"$tmp" || true)"
  rm -f "$tmp"

  RESPONSE_CODE="$(echo "$raw" | tail -1)"
  RESPONSE_BODY="$(echo "$raw" | sed '$d')"
}

# ---------------------------------------------------------------------------
# Resolve company
# ---------------------------------------------------------------------------
if [[ -z "${COMPANY_ID:-}" ]]; then
  log "Resolving company ID ..."
  api_request GET "/companies"
  if [[ "$RESPONSE_CODE" != "200" ]]; then
    fail "Could not list companies (HTTP $RESPONSE_CODE): $RESPONSE_BODY"
  fi
  COMPANY_ID="$(echo "$RESPONSE_BODY" | jq -r '.[0].id // empty')"
  [[ -n "$COMPANY_ID" ]] || fail "No companies found"
  log "Using company $COMPANY_ID"
fi

# ---------------------------------------------------------------------------
# List agents, build adapter -> agentId map
# ---------------------------------------------------------------------------
log "Fetching agents for company $COMPANY_ID ..."
api_request GET "/companies/$COMPANY_ID/agents"
if [[ "$RESPONSE_CODE" != "200" ]]; then
  fail "Could not list agents (HTTP $RESPONSE_CODE): $RESPONSE_BODY"
fi

AGENTS_JSON="$RESPONSE_BODY"
echo "$AGENTS_JSON" > "$SMOKE_DIAG_DIR/agents.json"

declare -A ADAPTER_AGENT_MAP   # adapter_type -> agent_id
declare -A ADAPTER_AGENT_NAME  # adapter_type -> agent name

for adapter in "${ADAPTER_LIST[@]}"; do
  agent_id="$(echo "$AGENTS_JSON" | jq -r --arg t "$adapter" \
    '[.[] | select(.adapterType == $t and .status != "terminated")] | first | .id // empty')"
  if [[ -z "$agent_id" ]]; then
    warn "No active agent found for adapter type '$adapter' -- will skip"
    continue
  fi
  agent_name="$(echo "$AGENTS_JSON" | jq -r --arg id "$agent_id" \
    '.[] | select(.id == $id) | .name')"
  ADAPTER_AGENT_MAP["$adapter"]="$agent_id"
  ADAPTER_AGENT_NAME["$adapter"]="$agent_name"
  log "  $adapter -> $agent_name ($agent_id)"
done

if [[ ${#ADAPTER_AGENT_MAP[@]} -eq 0 ]]; then
  fail "No agents found for any of the requested adapter types: ${ADAPTER_TYPES}"
fi

# ---------------------------------------------------------------------------
# Fire heartbeat for each adapter type and poll for "running"
# ---------------------------------------------------------------------------
declare -A RESULTS  # adapter_type -> PASS|FAIL|SKIP
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

poll_until_running() {
  local run_id="$1" timeout_sec="$2"
  local deadline=$((SECONDS + timeout_sec))
  local status=""

  while (( SECONDS < deadline )); do
    api_request GET "/heartbeat-runs/$run_id"
    if [[ "$RESPONSE_CODE" != "200" ]]; then
      warn "Failed to fetch run $run_id (HTTP $RESPONSE_CODE)"
      sleep 2
      continue
    fi

    status="$(echo "$RESPONSE_BODY" | jq -r '.status // empty')"
    case "$status" in
      running|succeeded)
        return 0
        ;;
      failed|cancelled|timed_out)
        warn "Run $run_id reached terminal status '$status' before running"
        return 1
        ;;
    esac

    sleep 2
  done

  warn "Run $run_id timed out after ${timeout_sec}s (last status: $status)"
  return 1
}

for adapter in "${ADAPTER_LIST[@]}"; do
  agent_id="${ADAPTER_AGENT_MAP[$adapter]:-}"
  if [[ -z "$agent_id" ]]; then
    RESULTS["$adapter"]="SKIP"
    (( SKIP_COUNT++ )) || true
    continue
  fi

  agent_name="${ADAPTER_AGENT_NAME[$adapter]}"
  log ""
  log "=== Testing adapter: $adapter ($agent_name) ==="

  # Fire wakeup
  api_request POST "/agents/$agent_id/wakeup" \
    '{"source":"on_demand","triggerDetail":"manual","reason":"post-deploy-smoke-test"}'

  if [[ "$RESPONSE_CODE" != "202" ]]; then
    warn "Wakeup failed for $adapter (HTTP $RESPONSE_CODE): $RESPONSE_BODY"
    echo "$RESPONSE_BODY" > "$SMOKE_DIAG_DIR/${adapter}-wakeup-error.json"
    RESULTS["$adapter"]="FAIL"
    (( FAIL_COUNT++ )) || true
    continue
  fi

  run_id="$(echo "$RESPONSE_BODY" | jq -r '.id // empty')"
  run_status="$(echo "$RESPONSE_BODY" | jq -r '.status // empty')"

  # Handle the "skipped" response (no run created)
  if [[ -z "$run_id" || "$run_id" == "null" ]]; then
    if echo "$RESPONSE_BODY" | jq -e '.status == "skipped"' >/dev/null 2>&1; then
      warn "Wakeup skipped for $adapter (agent may be paused or at max concurrency)"
      RESULTS["$adapter"]="SKIP"
      (( SKIP_COUNT++ )) || true
    else
      warn "Wakeup returned no run ID for $adapter"
      echo "$RESPONSE_BODY" > "$SMOKE_DIAG_DIR/${adapter}-wakeup-response.json"
      RESULTS["$adapter"]="FAIL"
      (( FAIL_COUNT++ )) || true
    fi
    continue
  fi

  log "  Run $run_id created (status: $run_status)"
  echo "$RESPONSE_BODY" > "$SMOKE_DIAG_DIR/${adapter}-run.json"

  # Poll until running
  if poll_until_running "$run_id" "$RUN_REACH_RUNNING_TIMEOUT"; then
    log "  PASS: $adapter reached running status"
    RESULTS["$adapter"]="PASS"
    (( PASS_COUNT++ )) || true

    # Cancel the run to avoid wasting budget on a smoke test
    if [[ "$CANCEL_AFTER_RUNNING" == "1" ]]; then
      api_request POST "/heartbeat-runs/$run_id/cancel"
      if [[ "$RESPONSE_CODE" == "200" || "$RESPONSE_CODE" == "204" ]]; then
        log "  Run cancelled to conserve budget"
      else
        warn "  Could not cancel run $run_id (HTTP $RESPONSE_CODE) -- run will continue"
      fi
    fi
  else
    log "  FAIL: $adapter did not reach running status"
    RESULTS["$adapter"]="FAIL"
    (( FAIL_COUNT++ )) || true

    # Capture diagnostics
    api_request GET "/heartbeat-runs/$run_id"
    echo "$RESPONSE_BODY" > "$SMOKE_DIAG_DIR/${adapter}-run-final.json"
    api_request GET "/heartbeat-runs/$run_id/events"
    echo "$RESPONSE_BODY" > "$SMOKE_DIAG_DIR/${adapter}-events.json"
    api_request GET "/heartbeat-runs/$run_id/log"
    echo "$RESPONSE_BODY" > "$SMOKE_DIAG_DIR/${adapter}-log.json"
  fi
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
log ""
log "========================================"
log " POST-DEPLOY ADAPTER SMOKE TEST RESULTS"
log "========================================"
for adapter in "${ADAPTER_LIST[@]}"; do
  result="${RESULTS[$adapter]:-SKIP}"
  case "$result" in
    PASS) icon="[PASS]" ;;
    FAIL) icon="[FAIL]" ;;
    SKIP) icon="[SKIP]" ;;
  esac
  log "  $icon  $adapter"
done
log ""
log "  Pass: $PASS_COUNT  Fail: $FAIL_COUNT  Skip: $SKIP_COUNT"
log "  Diagnostics: $SMOKE_DIAG_DIR"
log "========================================"

if (( FAIL_COUNT > 0 )); then
  fail "Smoke test failed: $FAIL_COUNT adapter(s) did not reach running status"
fi

log "All tested adapters passed."
exit 0
