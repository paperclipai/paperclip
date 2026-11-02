#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[hermes-gateway-join] $*"
}

warn() {
  echo "[hermes-gateway-join] WARN: $*" >&2
}

fail() {
  echo "[hermes-gateway-join] ERROR: $*" >&2
  exit 1
}

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || fail "missing required command: ${cmd}"
}

require_cmd curl
require_cmd jq

PAPERCLIP_API_URL="${PAPERCLIP_API_URL:-http://localhost:3100}"
API_BASE="${PAPERCLIP_API_URL%/}/api"
COMPANY_ID="${COMPANY_ID:-${PAPERCLIP_COMPANY_ID:-}}"
COMPANY_SELECTOR="${COMPANY_SELECTOR:-}"

HERMES_AGENT_NAME="${HERMES_AGENT_NAME:-Hermes Gateway Smoke Agent}"
HERMES_GATEWAY_API_BASE_URL="${HERMES_GATEWAY_API_BASE_URL:-http://127.0.0.1:${HERMES_GATEWAY_PORT:-8642}}"
HERMES_GATEWAY_PROBE_URL="${HERMES_GATEWAY_PROBE_URL:-$HERMES_GATEWAY_API_BASE_URL}"
HERMES_GATEWAY_API_KEY="${HERMES_GATEWAY_API_KEY:-${API_SERVER_KEY:-}}"
HERMES_GATEWAY_ALLOW_INSECURE_HTTP="${HERMES_GATEWAY_ALLOW_INSECURE_HTTP:-0}"
HERMES_GATEWAY_SESSION_KEY_STRATEGY="${HERMES_GATEWAY_SESSION_KEY_STRATEGY:-issue}"
HERMES_GATEWAY_TIMEOUT_SEC="${HERMES_GATEWAY_TIMEOUT_SEC:-180}"
PAPERCLIP_API_URL_FOR_HERMES="${PAPERCLIP_API_URL_FOR_HERMES:-}"
GATEWAY_PROBE_TIMEOUT_SEC="${GATEWAY_PROBE_TIMEOUT_SEC:-4}"
HERMES_JOIN_OUTPUT_FILE="${HERMES_JOIN_OUTPUT_FILE:-}"

print_usage() {
  cat <<'EOF'
Hermes gateway join smoke

Creates a Hermes gateway agent from an agent-only Paperclip invite, approves the
join request, claims the one-time Paperclip API key, and verifies the stored
adapter config without printing raw secrets.

Required:
  PAPERCLIP_API_URL=http://127.0.0.1:3100
  PAPERCLIP_AUTH_HEADER='Bearer <board-token>'     # or PAPERCLIP_COOKIE
  HERMES_GATEWAY_API_KEY=<API_SERVER_KEY>

Common flags:
  COMPANY_ID=<uuid> or COMPANY_SELECTOR=<prefix|name|uuid>
  HERMES_GATEWAY_API_BASE_URL=http://127.0.0.1:8642
  HERMES_GATEWAY_PROBE_URL=http://127.0.0.1:8642
  PAPERCLIP_API_URL_FOR_HERMES=http://host.docker.internal:3100
  HERMES_GATEWAY_ALLOW_INSECURE_HTTP=1             # dev-only non-loopback HTTP
  HERMES_GATEWAY_SESSION_KEY_STRATEGY=issue|agent|run|none
  HERMES_JOIN_OUTPUT_FILE=/secure/path/join-output.json

Notes:
  HERMES_GATEWAY_API_BASE_URL is stored on the Paperclip adapter and must be
  reachable by the Paperclip server. HERMES_GATEWAY_PROBE_URL is only used by
  this operator shell to preflight /health, which is useful when Paperclip talks
  to the gateway over a Docker network name but the operator probes localhost.

  Raw API keys are redacted from logs. HERMES_JOIN_OUTPUT_FILE contains the
  claimed Paperclip agent API key and is written chmod 600.

See doc/HERMES_GATEWAY_SMOKE.md for Docker Desktop, Linux, same-network,
LAN/private-network, and reverse-proxy/TLS examples.
EOF
}

case "${1:-}" in
  -h|--help)
    print_usage
    exit 0
    ;;
esac

AUTH_HEADERS=()
if [[ -n "${PAPERCLIP_AUTH_HEADER:-}" ]]; then
  AUTH_HEADERS+=(-H "Authorization: ${PAPERCLIP_AUTH_HEADER}")
elif [[ -n "${PAPERCLIP_API_KEY:-}" ]]; then
  AUTH_HEADERS+=(-H "Authorization: Bearer ${PAPERCLIP_API_KEY}")
fi
if [[ -n "${PAPERCLIP_COOKIE:-}" ]]; then
  AUTH_HEADERS+=(-H "Cookie: ${PAPERCLIP_COOKIE}")
fi

RESPONSE_CODE=""
RESPONSE_BODY=""
CLAIM_SECRET=""
AGENT_API_KEY=""

hash_prefix() {
  local value="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    printf "%s" "$value" | sha256sum | awk '{print substr($1,1,12)}'
  elif command -v shasum >/dev/null 2>&1; then
    printf "%s" "$value" | shasum -a 256 | awk '{print substr($1,1,12)}'
  else
    printf "unavailable"
  fi
}

redact_text() {
  local text="$1"
  local secret
  for secret in "${HERMES_GATEWAY_API_KEY:-}" "${CLAIM_SECRET:-}" "${AGENT_API_KEY:-}" "${PAPERCLIP_AUTH_HEADER:-}" "${PAPERCLIP_COOKIE:-}" "${PAPERCLIP_API_KEY:-}"; do
    if [[ -n "$secret" ]]; then
      text="${text//$secret/[redacted len=${#secret}]}"
    fi
  done
  printf "%s" "$text"
}

print_response_error() {
  redact_text "$RESPONSE_BODY" >&2
  echo >&2
}

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
    print_response_error
    fail "expected HTTP ${expected}, got HTTP ${RESPONSE_CODE}"
  fi
}

assert_json_has_string() {
  local jq_expr="$1"
  local value
  value="$(jq -r "$jq_expr // empty" <<<"$RESPONSE_BODY")"
  if [[ -z "$value" ]]; then
    print_response_error
    fail "expected JSON string at ${jq_expr}"
  fi
  echo "$value"
}

fail_board_auth_required() {
  local operation="$1"
  print_response_error
  cat >&2 <<EOF
[hermes-gateway-join] ERROR: ${operation} requires board/operator auth.

Provide one of:
  PAPERCLIP_AUTH_HEADER="Bearer <board-token>"
  PAPERCLIP_COOKIE="<board-session-cookie>"

Current auth context appears insufficient (HTTP ${RESPONSE_CODE}).
EOF
  exit 1
}

is_remote_plain_http() {
  local url="$1"
  [[ "$url" == http://* ]] || return 1
  ! is_loopback_http_host "$(url_host "$url")"
}

url_host() {
  local url="$1"
  local rest host_port host
  rest="${url#http://}"
  rest="${rest#https://}"
  if [[ "$rest" == \[*\]* ]]; then
    host="${rest#\[}"
    host="${host%%\]*}"
  else
    host_port="${rest%%/*}"
    host="${host_port%%:*}"
  fi
  printf "%s" "$host"
}

is_loopback_http_host() {
  local host
  host="$(printf "%s" "$1" | tr '[:upper:]' '[:lower:]')"
  case "$host" in
    localhost|0.0.0.0|::1|0:0:0:0:0:0:0:1) return 0 ;;
  esac
  [[ "$host" =~ ^127\.([0-9]{1,3}\.){2}[0-9]{1,3}$ ]]
}

strip_trailing_slash() {
  local value="$1"
  while [[ "$value" == */ && "$value" != "http://" && "$value" != "https://" ]]; do
    value="${value%/}"
  done
  printf "%s" "$value"
}

resolve_company_id() {
  if [[ -n "$COMPANY_ID" ]]; then
    return
  fi

  log "resolving company id"
  api_request "GET" "/companies"
  if [[ "$RESPONSE_CODE" == "401" || "$RESPONSE_CODE" == "403" ]]; then
    fail_board_auth_required "Company resolution"
  fi
  assert_status "200"

  if [[ -n "$COMPANY_SELECTOR" ]]; then
    COMPANY_ID="$(jq -r --arg selector "$COMPANY_SELECTOR" '
      map(select(
        (.id == $selector)
        or ((.issuePrefix // "") == $selector)
        or ((.name // "") == $selector)
      )) | .[0].id // empty
    ' <<<"$RESPONSE_BODY")"
    [[ -n "$COMPANY_ID" ]] || fail "no company matched COMPANY_SELECTOR=${COMPANY_SELECTOR}"
  else
    COMPANY_ID="$(jq -r '.[0].id // empty' <<<"$RESPONSE_BODY")"
    [[ -n "$COMPANY_ID" ]] || fail "no companies found; create one before running smoke test"
  fi
}

assert_onboarding_contains() {
  local body="$1"
  local needle="$2"
  if ! grep -Fq "$needle" <<<"$body"; then
    echo "$body" >&2
    fail "onboarding response missing expected text: ${needle}"
  fi
}

probe_hermes_gateway() {
  [[ -n "$HERMES_GATEWAY_API_BASE_URL" ]] || fail "HERMES_GATEWAY_API_BASE_URL is required"
  [[ -n "$HERMES_GATEWAY_PROBE_URL" ]] || fail "HERMES_GATEWAY_PROBE_URL is required"
  [[ -n "$HERMES_GATEWAY_API_KEY" ]] || fail "HERMES_GATEWAY_API_KEY or API_SERVER_KEY is required before any Paperclip state is mutated"

  if is_remote_plain_http "$HERMES_GATEWAY_API_BASE_URL" && [[ "$HERMES_GATEWAY_ALLOW_INSECURE_HTTP" != "1" ]]; then
    fail "HERMES_GATEWAY_API_BASE_URL uses non-loopback http. Set HERMES_GATEWAY_ALLOW_INSECURE_HTTP=1 for local-only unsafe HTTP, or use HTTPS."
  fi

  local health_url="${HERMES_GATEWAY_PROBE_URL%/}/health"
  log "probing Hermes gateway health at ${health_url} with apiKey sha256=$(hash_prefix "$HERMES_GATEWAY_API_KEY") len=${#HERMES_GATEWAY_API_KEY}"
  if [[ "$HERMES_GATEWAY_PROBE_URL" != "$HERMES_GATEWAY_API_BASE_URL" ]]; then
    log "Paperclip will store Hermes gateway URL ${HERMES_GATEWAY_API_BASE_URL}"
  fi
  local code
  code="$(curl -sS -o /dev/null -w "%{http_code}" --max-time "$GATEWAY_PROBE_TIMEOUT_SEC" -H "Authorization: Bearer ${HERMES_GATEWAY_API_KEY}" "$health_url" || true)"
  if [[ "$code" != "200" ]]; then
    fail "Hermes gateway health probe failed before mutating Paperclip state: ${health_url} returned HTTP ${code}. Start Hermes with API_SERVER_ENABLED=true API_SERVER_KEY=<key> hermes gateway run --replace --accept-hooks, or set HERMES_GATEWAY_API_BASE_URL/HERMES_GATEWAY_API_KEY."
  fi
}

log "checking Paperclip health"
api_request "GET" "/health"
assert_status "200"
log "deployment mode=$(jq -r '.deploymentMode // "unknown"' <<<"$RESPONSE_BODY") exposure=$(jq -r '.deploymentExposure // "unknown"' <<<"$RESPONSE_BODY")"

resolve_company_id
probe_hermes_gateway

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
ONBOARDING_JSON="$RESPONSE_BODY"
ONBOARDING_TEXT_PATH="$(jq -r '.invite.onboardingTextPath // empty' <<<"$ONBOARDING_JSON")"
[[ -n "$ONBOARDING_TEXT_PATH" ]] || fail "onboarding manifest missing invite.onboardingTextPath"
assert_onboarding_contains "$ONBOARDING_JSON" "hermes_gateway"
assert_onboarding_contains "$ONBOARDING_JSON" "API_SERVER_ENABLED=true"
assert_onboarding_contains "$ONBOARDING_JSON" "API_SERVER_KEY"
assert_onboarding_contains "$ONBOARDING_JSON" "agentDefaultsPayload"

api_request "GET" "/invites/${INVITE_TOKEN}/onboarding.txt"
assert_status "200"
ONBOARDING_TEXT="$RESPONSE_BODY"
assert_onboarding_contains "$ONBOARDING_TEXT" 'adapterType: "hermes_gateway"'
assert_onboarding_contains "$ONBOARDING_TEXT" "API_SERVER_ENABLED=true"
assert_onboarding_contains "$ONBOARDING_TEXT" "API_SERVER_KEY"
assert_onboarding_contains "$ONBOARDING_TEXT" "hermes gateway run --replace --accept-hooks"
assert_onboarding_contains "$ONBOARDING_TEXT" "agentDefaultsPayload.apiBaseUrl"

JOIN_PAYLOAD="$(jq -nc \
  --arg name "$HERMES_AGENT_NAME" \
  --arg apiBaseUrl "$HERMES_GATEWAY_API_BASE_URL" \
  --arg apiKey "$HERMES_GATEWAY_API_KEY" \
  --arg paperclipApiUrl "$PAPERCLIP_API_URL_FOR_HERMES" \
  --arg sessionKeyStrategy "$HERMES_GATEWAY_SESSION_KEY_STRATEGY" \
  --argjson timeoutSec "$HERMES_GATEWAY_TIMEOUT_SEC" \
  --argjson allowInsecure "$(if [[ "$HERMES_GATEWAY_ALLOW_INSECURE_HTTP" == "1" ]]; then echo true; else echo false; fi)" \
  '{
    requestType: "agent",
    agentName: $name,
    adapterType: "hermes_gateway",
    capabilities: "Hermes gateway Docker smoke harness",
    agentDefaultsPayload: {
      apiBaseUrl: $apiBaseUrl,
      apiKey: $apiKey,
      sessionKeyStrategy: $sessionKeyStrategy,
      timeoutSec: $timeoutSec
    }
  }
  | if $paperclipApiUrl != "" then .agentDefaultsPayload.paperclipApiUrl = $paperclipApiUrl else . end
  | if $allowInsecure then .agentDefaultsPayload.dangerouslyAllowInsecureRemoteHttp = true else . end')"

log "submitting Hermes gateway agent join request"
api_request "POST" "/invites/${INVITE_TOKEN}/accept" "$JOIN_PAYLOAD"
if [[ "$RESPONSE_CODE" != "202" ]]; then
  print_response_error
fi
assert_status "202"
JOIN_REQUEST_ID="$(assert_json_has_string '.id')"
CLAIM_SECRET="$(assert_json_has_string '.claimSecret')"
CLAIM_API_PATH="$(assert_json_has_string '.claimApiKeyPath')"
DIAGNOSTICS_JSON="$(jq -c '.diagnostics // []' <<<"$RESPONSE_BODY")"
if [[ "$DIAGNOSTICS_JSON" != "[]" ]]; then
  log "join diagnostics: $(redact_text "$DIAGNOSTICS_JSON")"
fi

if is_remote_plain_http "$HERMES_GATEWAY_API_BASE_URL"; then
  if ! jq -e '[.diagnostics[]? | select(.code == "hermes_gateway_plain_http_remote_unsafe_allowed")] | length > 0' <<<"$RESPONSE_BODY" >/dev/null; then
    fail "expected hermes_gateway_plain_http_remote_unsafe_allowed diagnostic for non-loopback HTTP join"
  fi
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

log "verifying stored Hermes gateway agent config"
api_request "GET" "/agents/${CREATED_AGENT_ID}"
assert_status "200"

AGENT_ADAPTER_TYPE="$(jq -r '.adapterType // empty' <<<"$RESPONSE_BODY")"
[[ "$AGENT_ADAPTER_TYPE" == "hermes_gateway" ]] || fail "expected adapterType=hermes_gateway, got ${AGENT_ADAPTER_TYPE}"

STORED_API_BASE_URL="$(jq -r '.adapterConfig.apiBaseUrl // empty' <<<"$RESPONSE_BODY")"
[[ -n "$STORED_API_BASE_URL" ]] || fail "stored adapterConfig.apiBaseUrl is missing"
if [[ "$(strip_trailing_slash "$STORED_API_BASE_URL")" != "$(strip_trailing_slash "$HERMES_GATEWAY_API_BASE_URL")" ]]; then
  fail "stored apiBaseUrl mismatch: expected $(strip_trailing_slash "$HERMES_GATEWAY_API_BASE_URL"), got $(strip_trailing_slash "$STORED_API_BASE_URL")"
fi

if jq -e --arg raw "$HERMES_GATEWAY_API_KEY" '.adapterConfig.apiKey == $raw' <<<"$RESPONSE_BODY" >/dev/null; then
  fail "stored adapterConfig.apiKey leaked the raw Hermes API key"
fi
if ! jq -e '(.adapterConfig.apiKey.type // "") == "secret_ref"' <<<"$RESPONSE_BODY" >/dev/null; then
  warn "stored adapterConfig.apiKey is not a visible secret_ref; response shape may redact it entirely"
fi

STORED_SESSION_STRATEGY="$(jq -r '.adapterConfig.sessionKeyStrategy // empty' <<<"$RESPONSE_BODY")"
[[ "$STORED_SESSION_STRATEGY" == "$HERMES_GATEWAY_SESSION_KEY_STRATEGY" ]] || fail "stored sessionKeyStrategy mismatch: expected ${HERMES_GATEWAY_SESSION_KEY_STRATEGY}, got ${STORED_SESSION_STRATEGY:-<empty>}"

if [[ -n "$PAPERCLIP_API_URL_FOR_HERMES" ]]; then
  STORED_PAPERCLIP_API_URL="$(jq -r '.adapterConfig.paperclipApiUrl // empty' <<<"$RESPONSE_BODY")"
  [[ "$STORED_PAPERCLIP_API_URL" == "$PAPERCLIP_API_URL_FOR_HERMES" || "$(strip_trailing_slash "$STORED_PAPERCLIP_API_URL")" == "$(strip_trailing_slash "$PAPERCLIP_API_URL_FOR_HERMES")" ]] \
    || fail "stored paperclipApiUrl mismatch"
fi

log "success"
log "companyId=${COMPANY_ID}"
log "inviteId=${INVITE_ID}"
log "joinRequestId=${JOIN_REQUEST_ID}"
log "agentId=${CREATED_AGENT_ID}"
log "keyId=${KEY_ID}"
log "hermesGatewayApiKeySha256=$(hash_prefix "$HERMES_GATEWAY_API_KEY") len=${#HERMES_GATEWAY_API_KEY}"
log "agentApiKeySha256=$(hash_prefix "$AGENT_API_KEY") len=${#AGENT_API_KEY}"

if [[ -n "$HERMES_JOIN_OUTPUT_FILE" ]]; then
  mkdir -p "$(dirname "$HERMES_JOIN_OUTPUT_FILE")"
  jq -nc \
    --arg companyId "$COMPANY_ID" \
    --arg inviteId "$INVITE_ID" \
    --arg joinRequestId "$JOIN_REQUEST_ID" \
    --arg agentId "$CREATED_AGENT_ID" \
    --arg keyId "$KEY_ID" \
    --arg agentApiKey "$AGENT_API_KEY" \
    --arg hermesGatewayApiKeySha256 "$(hash_prefix "$HERMES_GATEWAY_API_KEY")" \
    --arg agentApiKeySha256 "$(hash_prefix "$AGENT_API_KEY")" \
    '{
      companyId: $companyId,
      inviteId: $inviteId,
      joinRequestId: $joinRequestId,
      agentId: $agentId,
      keyId: $keyId,
      agentApiKey: $agentApiKey,
      hermesGatewayApiKeySha256: $hermesGatewayApiKeySha256,
      agentApiKeySha256: $agentApiKeySha256
    }' > "$HERMES_JOIN_OUTPUT_FILE"
  chmod 600 "$HERMES_JOIN_OUTPUT_FILE"
  log "wrote join metadata to ${HERMES_JOIN_OUTPUT_FILE} (contains secret material; chmod 600)"
fi
