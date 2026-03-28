#!/usr/bin/env bash
set -euo pipefail

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

PAPERCLIP_API_URL="${PAPERCLIP_API_URL:-http://localhost:3100}"
API_BASE="${PAPERCLIP_API_URL%/}/api"
COMPANY_ID="${COMPANY_ID:-${PAPERCLIP_COMPANY_ID:-}}"
OPENCLAW_AGENT_NAME="${OPENCLAW_AGENT_NAME:-OpenClaw Smoke Agent}"
OPENCLAW_WEBHOOK_URL="${OPENCLAW_WEBHOOK_URL:-}"
OPENCLAW_WEBHOOK_AUTH="${OPENCLAW_WEBHOOK_AUTH:-Bearer openclaw-smoke-secret}"
USE_DOCKER_RECEIVER="${USE_DOCKER_RECEIVER:-1}"
SMOKE_IMAGE="${SMOKE_IMAGE:-paperclip-openclaw-smoke:local}"
SMOKE_CONTAINER_NAME="${SMOKE_CONTAINER_NAME:-paperclip-openclaw-smoke}"
SMOKE_PORT="${SMOKE_PORT:-19091}"
SMOKE_TIMEOUT_SEC="${SMOKE_TIMEOUT_SEC:-45}"

AUTH_HEADERS=()
if [[ -n "${PAPERCLIP_AUTH_HEADER:-}" ]]; then
  AUTH_HEADERS+=(-H "Authorization: ${PAPERCLIP_AUTH_HEADER}")
fi
if [[ -n "${PAPERCLIP_COOKIE:-}" ]]; then
  AUTH_HEADERS+=(-H "Cookie: ${PAPERCLIP_COOKIE}")
fi

STARTED_CONTAINER=0
RESPONSE_CODE=""
RESPONSE_BODY=""

log() {
  echo "[openclaw-smoke] $*"
}

fail() {
  echo "[openclaw-smoke] ERROR: $*" >&2
  exit 1
}

fail_board_auth_required() {
  local operation="$1"
  echo "$RESPONSE_BODY" >&2
  cat >&2 <<EOF
[openclaw-smoke] ERROR: ${operation} requires board/operator auth.

Provide one of:
  PAPERCLIP_AUTH_HEADER=\"Bearer <board-token>\"
  PAPERCLIP_COOKIE=\"<board-session-cookie>\"

Current auth context appears insufficient (HTTP ${RESPONSE_CODE}).
EOF
  exit 1
}

cleanup() {
  if [[ "$STARTED_CONTAINER" == "1" ]]; then
    docker rm -f "$SMOKE_CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

api_request() {
  local method="$1"
  local path="$2"
  local data="${3-}"
  local tmp
  tmp="$(mktemp)"
  local url
  if [[ "$path" == http://* || "$path" == https://* ]]; then
    url="$path"
  elif [[ "$path" == /api/* ]]; then
    url="${PAPERCLIP_API_URL%/}${path}"
  else
    url="${API_BASE}${path}"
  fi

  if [[ -n "$data" ]]; then
    RESPONSE_CODE="$(curl -sS -o "$tmp" -w "%{http_code}" -X "$method" "${AUTH_HEADERS[@]}" -H "Content-Type: application/json" "$url" --data "$data")"
  else
    RESPONSE_CODE="$(curl -sS -o "$tmp" -w "%{http_code}" -X "$method" "${AUTH_HEADERS[@]}" "$url")"
  fi
  RESPONSE_BODY="$(cat "$tmp")"
  rm -f "$tmp"
}

assert_status() {
  local expected="$1"
  if [[ "$RESPONSE_CODE" != "$expected" ]]; then
    echo "$RESPONSE_BODY" >&2
    fail "expected HTTP $expected, got HTTP $RESPONSE_CODE"
  fi
}

assert_json_has_string() {
  local jq_expr="$1"
  local value
  value="$(jq -r "$jq_expr // empty" <<<"$RESPONSE_BODY")"
  if [[ -z "$value" ]]; then
    echo "$RESPONSE_BODY" >&2
    fail "expected JSON string at: $jq_expr"
  fi
  echo "$value"
}

if [[ "$USE_DOCKER_RECEIVER" == "1" && -z "$OPENCLAW_WEBHOOK_URL" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    fail "docker is required when USE_DOCKER_RECEIVER=1"
  fi
  log "building dockerized OpenClaw webhook receiver image"
  docker build -t "$SMOKE_IMAGE" -f docker/openclaw-smoke/Dockerfile docker/openclaw-smoke >/dev/null
  docker rm -f "$SMOKE_CONTAINER_NAME" >/dev/null 2>&1 || true

  log "starting dockerized OpenClaw webhook receiver"
  docker run -d \
    --name "$SMOKE_CONTAINER_NAME" \
    -p "${SMOKE_PORT}:8787" \
    -e "OPENCLAW_SMOKE_AUTH=${OPENCLAW_WEBHOOK_AUTH}" \
    "$SMOKE_IMAGE" >/dev/null
  STARTED_CONTAINER=1
  OPENCLAW_WEBHOOK_URL="http://127.0.0.1:${SMOKE_PORT}/webhook"

  for _ in $(seq 1 30); do
    code="$(curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:${SMOKE_PORT}/health" || true)"
    if [[ "$code" == "200" ]]; then
      break
    fi
    sleep 1
  done
  code="$(curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:${SMOKE_PORT}/health" || true)"
  if [[ "$code" != "200" ]]; then
    fail "webhook receiver failed health check on port ${SMOKE_PORT}"
  fi
fi

if [[ -z "$OPENCLAW_WEBHOOK_URL" ]]; then
  fail "OPENCLAW_WEBHOOK_URL must be set when USE_DOCKER_RECEIVER=0"
fi

log "checking Paperclip health"
api_request "GET" "/health"
assert_status "200"
DEPLOYMENT_MODE="$(jq -r '.deploymentMode // "unknown"' <<<"$RESPONSE_BODY")"
DEPLOYMENT_EXPOSURE="$(jq -r '.deploymentExposure // "unknown"' <<<"$RESPONSE_BODY")"
log "deployment mode=${DEPLOYMENT_MODE} exposure=${DEPLOYMENT_EXPOSURE}"

if [[ -z "$COMPANY_ID" ]]; then
  log "resolving company id"
  api_request "GET" "/companies"
  assert_status "200"
  COMPANY_ID="$(jq -r '.[0].id // empty' <<<"$RESPONSE_BODY")"
  if [[ -z "$COMPANY_ID" ]]; then
    fail "no companies found; create one before running smoke test"
  fi
fi

log "creating agent-only invite for company ${COMPANY_ID}"
INVITE_PAYLOAD="$(jq -nc '{allowedJoinTypes:"agent"}')"
api_request "POST" "/companies/${COMPANY_ID}/invites" "$INVITE_PAYLOAD"
if [[ "$RESPONSE_CODE" == "401" || "$RESPONSE_CODE" == "403" ]]; then
  fail_board_auth_required "Invite creation"
fi
assert_status "201"
INVITE_TOKEN="$(assert_json_has_string '.token')"
INVITE_ID="$(assert_json_has_string '.id')"
log "created invite ${INVITE_ID}"

log "verifying onboarding JSON and text endpoints"
api_request "GET" "/invites/${INVITE_TOKEN}/onboarding"
assert_status "200"
ONBOARDING_TEXT_PATH="$(jq -r '.invite.onboardingTextPath // empty' <<<"$RESPONSE_BODY")"
if [[ -z "$ONBOARDING_TEXT_PATH" ]]; then
  fail "onboarding manifest missing invite.onboardingTextPath"
fi
api_request "GET" "/invites/${INVITE_TOKEN}/onboarding.txt"
assert_status "200"
if ! grep -q "Paperclip OpenClaw Gateway Onboarding" <<<"$RESPONSE_BODY"; then
  fail "onboarding.txt response missing expected header"
fi

OPENCLAW_GATEWAY_URL="${OPENCLAW_GATEWAY_URL:-ws://127.0.0.1:18789}"
OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-${OPENCLAW_WEBHOOK_AUTH#Bearer }}"
if [[ -z "$OPENCLAW_GATEWAY_TOKEN" ]]; then
  fail "OPENCLAW_GATEWAY_TOKEN (or OPENCLAW_WEBHOOK_AUTH) is required for gateway join"
fi

log "submitting OpenClaw gateway agent join request"
JOIN_PAYLOAD="$(jq -nc \
  --arg name "$OPENCLAW_AGENT_NAME" \
  --arg url "$OPENCLAW_GATEWAY_URL" \
  --arg token "$OPENCLAW_GATEWAY_TOKEN" \
  '{
    requestType: "agent",
    agentName: $name,
    adapterType: "openclaw_gateway",
    capabilities: "Automated OpenClaw gateway smoke harness",
    agentDefaultsPayload: {
      url: $url,
      headers: { "x-openclaw-token": $token },
      sessionKeyStrategy: "issue",
      waitTimeoutMs: 120000
    }
  }')"
api_request "POST" "/invites/${INVITE_TOKEN}/accept" "$JOIN_PAYLOAD"
assert_status "202"
JOIN_REQUEST_ID="$(assert_json_has_string '.id')"
CLAIM_SECRET="$(assert_json_has_string '.claimSecret')"
CLAIM_API_PATH="$(assert_json_has_string '.claimApiKeyPath')"
DIAGNOSTICS_JSON="$(jq -c '.diagnostics // []' <<<"$RESPONSE_BODY")"
if [[ "$DIAGNOSTICS_JSON" != "[]" ]]; then
  log "join diagnostics: ${DIAGNOSTICS_JSON}"
fi

log "approving join request ${JOIN_REQUEST_ID}"
api_request "POST" "/companies/${COMPANY_ID}/join-requests/${JOIN_REQUEST_ID}/approve" "{}"
if [[ "$RESPONSE_CODE" == "401" || "$RESPONSE_CODE" == "403" ]]; then
  fail_board_auth_required "Join approval"
fi
assert_status "200"
CREATED_AGENT_ID="$(assert_json_has_string '.createdAgentId')"

log "verifying invalid claim secret is rejected"
api_request "POST" "/join-requests/${JOIN_REQUEST_ID}/claim-api-key" '{"claimSecret":"invalid-smoke-secret-value"}'
if [[ "$RESPONSE_CODE" == "201" ]]; then
  fail "invalid claim secret unexpectedly succeeded"
fi

log "claiming API key with one-time claim secret"
CLAIM_PAYLOAD="$(jq -nc --arg secret "$CLAIM_SECRET" '{claimSecret:$secret}')"
api_request "POST" "$CLAIM_API_PATH" "$CLAIM_PAYLOAD"
assert_status "201"
AGENT_API_KEY="$(assert_json_has_string '.token')"
KEY_ID="$(assert_json_has_string '.keyId')"

log "verifying replay claim is rejected"
api_request "POST" "$CLAIM_API_PATH" "$CLAIM_PAYLOAD"
if [[ "$RESPONSE_CODE" == "201" ]]; then
  fail "claim secret replay unexpectedly succeeded"
fi

if [[ "$USE_DOCKER_RECEIVER" == "1" && "$STARTED_CONTAINER" == "1" ]]; then
  curl -sS -X POST "http://127.0.0.1:${SMOKE_PORT}/reset" >/dev/null
fi

log "triggering wakeup for newly created OpenClaw agent"
WAKE_PAYLOAD='{"source":"on_demand","triggerDetail":"manual","reason":"openclaw_smoke"}'
api_request "POST" "/agents/${CREATED_AGENT_ID}/wakeup" "$WAKE_PAYLOAD"
if [[ "$RESPONSE_CODE" == "401" || "$RESPONSE_CODE" == "403" ]]; then
  fail_board_auth_required "Agent wakeup"
fi
assert_status "202"
RUN_ID="$(jq -r '.id // empty' <<<"$RESPONSE_BODY")"
if [[ -z "$RUN_ID" ]]; then
  log "wakeup response: ${RESPONSE_BODY}"
fi

log "waiting for webhook callback"
FOUND_EVENT="0"
LAST_EVENTS='{"count":0,"events":[]}'
for _ in $(seq 1 "$SMOKE_TIMEOUT_SEC"); do
  if [[ "$USE_DOCKER_RECEIVER" == "1" && "$STARTED_CONTAINER" == "1" ]]; then
    LAST_EVENTS="$(curl -sS "http://127.0.0.1:${SMOKE_PORT}/events")"
  else
    break
  fi
  MATCH_COUNT="$(jq -r --arg agentId "$CREATED_AGENT_ID" '[.events[] | select(((.body.paperclip.agentId // "") == $agentId))] | length' <<<"$LAST_EVENTS")"
  if [[ "$MATCH_COUNT" -gt 0 ]]; then
    FOUND_EVENT="1"
    break
  fi
  sleep 1
done

if [[ "$USE_DOCKER_RECEIVER" == "1" && "$STARTED_CONTAINER" == "1" && "$FOUND_EVENT" != "1" ]]; then
  echo "$LAST_EVENTS" | jq '.' >&2
  fail "did not observe OpenClaw webhook callback within ${SMOKE_TIMEOUT_SEC}s"
fi

log "success"
log "companyId=${COMPANY_ID}"
log "inviteId=${INVITE_ID}"
log "joinRequestId=${JOIN_REQUEST_ID}"
log "agentId=${CREATED_AGENT_ID}"
log "keyId=${KEY_ID}"
if [[ -n "$RUN_ID" ]]; then
  log "runId=${RUN_ID}"
fi
if [[ -n "$AGENT_API_KEY" ]]; then
  log "agentApiKeyPrefix=${AGENT_API_KEY:0:12}..."
fi
