#!/usr/bin/env bash
# setup-hermes-vllm.sh
#
# Creates or updates a "Hermes vLLM" agent in Paperclip configured to use a
# local vLLM endpoint via the hermes_local adapter.  After ensuring the agent
# exists it assigns a short smoke-test task to verify end-to-end connectivity.
#
# Usage:
#   ./scripts/setup-hermes-vllm.sh
#
# Environment variables (all optional – defaults shown):
#   PAPERCLIP_URL        http://localhost:3100
#   PAPERCLIP_API_KEY    pclp_tgbot_fa99aa1d16ca8eeaf0022f1341311641ec315cbc48c5fdec
#   PAPERCLIP_COMPANY_ID dbc742c7-9a38-4542-936b-523dfa3a7fd2

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

PAPERCLIP_URL="${PAPERCLIP_URL:-http://localhost:3100}"
PAPERCLIP_API_KEY="${PAPERCLIP_API_KEY:-pclp_tgbot_fa99aa1d16ca8eeaf0022f1341311641ec315cbc48c5fdec}"
PAPERCLIP_COMPANY_ID="${PAPERCLIP_COMPANY_ID:-dbc742c7-9a38-4542-936b-523dfa3a7fd2}"

API_BASE="${PAPERCLIP_URL%/}/api"
AGENT_NAME="Hermes vLLM"
ADAPTER_TYPE="hermes_local"

# Adapter configuration — hermes runs in its own sidecar container (paperclip-hermes-1).
# The server container calls it via the hermes-docker wrapper (docker exec).
# Model + vLLM base URL are baked into the sidecar's config.yaml mount; no env passthrough needed.
ADAPTER_CONFIG='{
  "hermesCommand": "hermes-docker",
  "model": "google/gemma-4-26B-A4B-it",
  "toolsets": "terminal,file,web",
  "persistSession": true,
  "timeoutSec": 600,
  "paperclipApiUrl": "http://server:3100/api"
}'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log()  { echo "[hermes-vllm] $*"; }
warn() { echo "[hermes-vllm] WARN: $*" >&2; }
fail() { echo "[hermes-vllm] ERROR: $*" >&2; exit 1; }

require_cmd() { command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"; }

require_cmd curl
require_cmd jq

# Perform an authenticated API call.
#   api_call <METHOD> <path> [json-body]
# Prints the response body and sets HTTP_CODE.
HTTP_CODE=""
api_call() {
  local method="$1"
  local path="$2"
  local data="${3-}"
  local url="${API_BASE}${path}"
  local tmp
  tmp="$(mktemp)"

  local curl_args=( -s -o "$tmp" -w "%{http_code}"
    -X "$method"
    -H "Authorization: Bearer ${PAPERCLIP_API_KEY}"
    -H "Content-Type: application/json"
  )

  if [[ -n "$data" ]]; then
    curl_args+=( --data "$data" )
  fi

  HTTP_CODE="$(curl "${curl_args[@]}" "$url")"
  local body
  body="$(cat "$tmp")"
  rm -f "$tmp"

  # Emit the body so callers can capture it with $()
  printf '%s' "$body"
}

# ---------------------------------------------------------------------------
# 1. Check whether the agent already exists
# ---------------------------------------------------------------------------

log "Searching for existing agent named '${AGENT_NAME}' in company ${PAPERCLIP_COMPANY_ID}…"

LIST_RESPONSE="$(api_call GET "/companies/${PAPERCLIP_COMPANY_ID}/agents")"

if [[ "$HTTP_CODE" != "200" ]]; then
  warn "Response body: ${LIST_RESPONSE}"
  fail "Failed to list agents (HTTP ${HTTP_CODE}). Check PAPERCLIP_URL and PAPERCLIP_API_KEY."
fi

# Find an agent whose name matches exactly (case-sensitive)
EXISTING_ID="$(printf '%s' "$LIST_RESPONSE" | jq -r --arg name "$AGENT_NAME" \
  'if type == "array" then . elif .agents then .agents else [] end
   | map(select(.name == $name)) | first | .id // empty')"

# ---------------------------------------------------------------------------
# 2. Create or update the agent
# ---------------------------------------------------------------------------

if [[ -z "$EXISTING_ID" ]]; then
  # ---- CREATE ----
  log "No existing agent found. Creating '${AGENT_NAME}'…"

  CREATE_BODY="$(jq -n \
    --arg name "$AGENT_NAME" \
    --arg adapterType "$ADAPTER_TYPE" \
    --arg companyId "$PAPERCLIP_COMPANY_ID" \
    --argjson adapterConfig "$ADAPTER_CONFIG" \
    '{
      name: $name,
      adapterType: $adapterType,
      companyId: $companyId,
      adapterConfig: $adapterConfig,
      role: "engineer",
      title: "Hermes vLLM Agent"
    }')"

  CREATE_RESPONSE="$(api_call POST "/companies/${PAPERCLIP_COMPANY_ID}/agents" "$CREATE_BODY")"

  if [[ "$HTTP_CODE" != "200" && "$HTTP_CODE" != "201" ]]; then
    warn "Response body: ${CREATE_RESPONSE}"
    fail "Failed to create agent (HTTP ${HTTP_CODE})."
  fi

  AGENT_ID="$(printf '%s' "$CREATE_RESPONSE" | jq -r '.id // .agent.id')"
  log "Agent created. ID: ${AGENT_ID}"

else
  # ---- UPDATE ----
  AGENT_ID="$EXISTING_ID"
  log "Found existing agent (ID: ${AGENT_ID}). Updating adapterConfig…"

  UPDATE_BODY="$(jq -n \
    --argjson adapterConfig "$ADAPTER_CONFIG" \
    '{ adapterConfig: $adapterConfig }')"

  UPDATE_RESPONSE="$(api_call PATCH "/agents/${AGENT_ID}" "$UPDATE_BODY")"

  if [[ "$HTTP_CODE" != "200" ]]; then
    warn "Response body: ${UPDATE_RESPONSE}"
    fail "Failed to update agent (HTTP ${HTTP_CODE})."
  fi

  log "Agent updated successfully."
fi

# Validate that we have an agent ID before continuing
if [[ -z "$AGENT_ID" || "$AGENT_ID" == "null" ]]; then
  fail "Could not determine agent ID from API response."
fi

# ---------------------------------------------------------------------------
# 3. Assign a smoke-test task (issue) to the agent
# ---------------------------------------------------------------------------

log "Assigning smoke-test task to agent ${AGENT_ID}…"

TASK_BODY="$(jq -n \
  --arg companyId "$PAPERCLIP_COMPANY_ID" \
  --arg assigneeAgentId "$AGENT_ID" \
  '{
    title: "Smoke test: Hermes vLLM agent",
    body: "Reply with the current date and a haiku about local AI inference.",
    companyId: $companyId,
    assigneeAgentId: $assigneeAgentId
  }')"

TASK_RESPONSE="$(api_call POST "/companies/${PAPERCLIP_COMPANY_ID}/issues" "$TASK_BODY")"

if [[ "$HTTP_CODE" != "200" && "$HTTP_CODE" != "201" ]]; then
  warn "Response body: ${TASK_RESPONSE}"
  fail "Failed to create smoke-test task (HTTP ${HTTP_CODE})."
fi

TASK_ID="$(printf '%s' "$TASK_RESPONSE" | jq -r '.id // .issue.id')"

if [[ -z "$TASK_ID" || "$TASK_ID" == "null" ]]; then
  warn "Task response: ${TASK_RESPONSE}"
  fail "Could not determine task ID from API response."
fi

log "Smoke-test task created. ID: ${TASK_ID}"

# ---------------------------------------------------------------------------
# 4. Summary
# ---------------------------------------------------------------------------

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Hermes vLLM agent setup complete"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Agent name : ${AGENT_NAME}"
echo "  Agent ID   : ${AGENT_ID}"
echo "  Task ID    : ${TASK_ID}"
echo "  Model      : google/gemma-4-E4B-it (via vLLM sidecar)"
echo "  vLLM base  : http://vllm:8000/v1 (docker/hermes/config.yaml)"
echo "  hermesCmd  : hermes-docker → docker exec paperclip-hermes-1"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
