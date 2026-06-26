#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[hermes-gateway-e2e] $*"
}

warn() {
  echo "[hermes-gateway-e2e] WARN: $*" >&2
}

fail() {
  echo "[hermes-gateway-e2e] ERROR: $*" >&2
  if [[ -n "${HERMES_SMOKE_DIAG_DIR:-}" ]]; then
    mkdir -p "$HERMES_SMOKE_DIAG_DIR" 2>/dev/null || true
    printf "%s\n" "$*" > "${HERMES_SMOKE_DIAG_DIR}/failure.txt" 2>/dev/null || true
  fi
  exit 1
}

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || fail "missing required command: ${cmd}"
}

PAPERCLIP_API_URL="${PAPERCLIP_API_URL:-http://127.0.0.1:3100}"
API_BASE="${PAPERCLIP_API_URL%/}/api"
COMPANY_ID="${COMPANY_ID:-${PAPERCLIP_COMPANY_ID:-}}"
COMPANY_SELECTOR="${COMPANY_SELECTOR:-}"

RUN_SUFFIX="${HERMES_SMOKE_RUN_SUFFIX:-$(date +%Y%m%d-%H%M%S)-$$}"
HERMES_IMAGE="${HERMES_IMAGE:-paperclip-hermes-gateway-smoke:local}"
HERMES_VERSION="${HERMES_VERSION:-0.17.0}"
HERMES_BUILD="${HERMES_BUILD:-1}"
HERMES_DOCKER_CONTEXT="${HERMES_DOCKER_CONTEXT:-docker/hermes-gateway-smoke}"
HERMES_CONTAINER_NAME="${HERMES_CONTAINER_NAME:-paperclip-hermes-gateway-smoke-${RUN_SUFFIX}}"
HERMES_GATEWAY_PORT="${HERMES_GATEWAY_PORT:-8642}"
HERMES_GATEWAY_API_BASE_URL="${HERMES_GATEWAY_API_BASE_URL:-http://127.0.0.1:${HERMES_GATEWAY_PORT}}"
HERMES_GATEWAY_PROBE_URL="${HERMES_GATEWAY_PROBE_URL:-http://127.0.0.1:${HERMES_GATEWAY_PORT}}"
HERMES_GATEWAY_API_KEY="${HERMES_GATEWAY_API_KEY:-${API_SERVER_KEY:-}}"
HERMES_GATEWAY_ALLOW_INSECURE_HTTP="${HERMES_GATEWAY_ALLOW_INSECURE_HTTP:-0}"
HERMES_GATEWAY_SESSION_KEY_STRATEGY="${HERMES_GATEWAY_SESSION_KEY_STRATEGY:-issue}"
HERMES_ADAPTER_TIMEOUT_SEC="${HERMES_ADAPTER_TIMEOUT_SEC:-180}"
HERMES_DIRECT_RUN_TIMEOUT_SEC="${HERMES_DIRECT_RUN_TIMEOUT_SEC:-180}"
HERMES_STOP_ASSERT="${HERMES_STOP_ASSERT:-auto}"
HERMES_SMOKE_KEEP="${HERMES_SMOKE_KEEP:-0}"
HERMES_SMOKE_NETWORK="${HERMES_SMOKE_NETWORK:-}"
HERMES_DOCKER_ADD_HOST="${HERMES_DOCKER_ADD_HOST:-1}"
HERMES_SMOKE_STATE_DIR="${HERMES_SMOKE_STATE_DIR:-${TMPDIR:-/tmp}/paperclip-hermes-gateway-smoke-${RUN_SUFFIX}}"
HERMES_SMOKE_DIAG_DIR="${HERMES_SMOKE_DIAG_DIR:-${TMPDIR:-/tmp}/paperclip-hermes-gateway-e2e-diag-${RUN_SUFFIX}}"
HERMES_AGENT_NAME="${HERMES_AGENT_NAME:-Hermes Gateway Smoke Agent ${RUN_SUFFIX}}"
PAPERCLIP_API_URL_FOR_HERMES="${PAPERCLIP_API_URL_FOR_HERMES:-http://host.docker.internal:3100}"
RUN_TIMEOUT_SEC="${RUN_TIMEOUT_SEC:-420}"
CASE_TIMEOUT_SEC="${CASE_TIMEOUT_SEC:-420}"
GATEWAY_READY_TIMEOUT_SEC="${GATEWAY_READY_TIMEOUT_SEC:-90}"
STRICT_CASES="${STRICT_CASES:-1}"

print_usage() {
  cat <<'EOF'
Hermes gateway Docker E2E smoke

Builds a fresh Hermes gateway container, verifies the gateway API directly,
joins it to Paperclip as a hermes_gateway agent, wakes that agent on a smoke
issue, verifies the issue result, captures redacted diagnostics, and cleans up
Paperclip and Docker state unless HERMES_SMOKE_KEEP=1.

Required:
  PAPERCLIP_API_URL=http://127.0.0.1:3100
  PAPERCLIP_AUTH_HEADER='Bearer <board-token>'     # or PAPERCLIP_COOKIE

Common flags:
  COMPANY_ID=<uuid> or COMPANY_SELECTOR=<prefix|name|uuid>
  HERMES_VERSION=0.17.0
  HERMES_IMAGE=paperclip-hermes-gateway-smoke:local
  HERMES_GATEWAY_PORT=8642
  HERMES_GATEWAY_API_BASE_URL=http://127.0.0.1:8642
  HERMES_GATEWAY_PROBE_URL=http://127.0.0.1:8642
  PAPERCLIP_API_URL_FOR_HERMES=http://host.docker.internal:3100
  HERMES_GATEWAY_ALLOW_INSECURE_HTTP=1             # dev-only non-loopback HTTP
  HERMES_SMOKE_NETWORK=<docker-network>
  HERMES_DOCKER_ADD_HOST=0|1
  HERMES_SMOKE_KEEP=1                              # keep diagnostics/container
  HERMES_SMOKE_DIAG_DIR=/tmp/hermes-gateway-diag

Mode notes:
  HERMES_GATEWAY_API_BASE_URL is the URL stored on the Paperclip adapter and
  must be reachable by the Paperclip server. HERMES_GATEWAY_PROBE_URL is the URL
  this operator shell uses for direct gateway checks. They can differ for Docker
  network and reverse-proxy smoke runs.

  Raw Hermes and Paperclip API keys are redacted from logs and diagnostic files.
  The generated/claimed key material is kept only in the per-run state directory,
  which is deleted on success unless HERMES_SMOKE_KEEP=1.

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
  PAPERCLIP_BROWSER_ORIGIN="${PAPERCLIP_BROWSER_ORIGIN:-${PAPERCLIP_API_URL%/}}"
  AUTH_HEADERS+=(-H "Origin: ${PAPERCLIP_BROWSER_ORIGIN}" -H "Referer: ${PAPERCLIP_BROWSER_ORIGIN}/")
fi

RESPONSE_CODE=""
RESPONSE_BODY=""
AGENT_ID=""
AGENT_API_KEY=""
INVITE_ID=""
JOIN_REQUEST_ID=""
KEY_ID=""
SMOKE_ISSUE_ID=""
SMOKE_ISSUE_IDENTIFIER=""
RUN_ID=""
DIRECT_RUN_ID=""
STOP_RUN_ID=""
JOIN_OUTPUT_FILE="${HERMES_SMOKE_DIAG_DIR}/join-output.json"
KEEP_ON_EXIT="$HERMES_SMOKE_KEEP"

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

generate_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif command -v node >/dev/null 2>&1; then
    node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
  else
    fail "missing openssl or node for API_SERVER_KEY generation"
  fi
}

redact_text() {
  local text="$1"
  local secret
  for secret in \
    "${HERMES_GATEWAY_API_KEY:-}" \
    "${AGENT_API_KEY:-}" \
    "${PAPERCLIP_API_KEY:-}" \
    "${PAPERCLIP_AUTH_HEADER:-}" \
    "${PAPERCLIP_COOKIE:-}"; do
    if [[ -n "$secret" ]]; then
      text="${text//$secret/[redacted len=${#secret}]}"
    fi
  done
  printf "%s" "$text"
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

is_remote_plain_http() {
  local url="$1"
  [[ "$url" == http://* ]] || return 1
  ! is_loopback_http_host "$(url_host "$url")"
}

assert_gateway_api_base_url_allowed() {
  if is_remote_plain_http "$HERMES_GATEWAY_API_BASE_URL" && [[ "$HERMES_GATEWAY_ALLOW_INSECURE_HTTP" != "1" ]]; then
    fail "HERMES_GATEWAY_API_BASE_URL uses non-loopback http. Set HERMES_GATEWAY_ALLOW_INSECURE_HTTP=1 for local-only unsafe HTTP, or use HTTPS."
  fi
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
    redact_text "$RESPONSE_BODY" >&2
    echo >&2
    fail "expected HTTP ${expected}, got HTTP ${RESPONSE_CODE}"
  fi
}

gateway_request() {
  local method="$1"
  local path="$2"
  local data="${3-}"
  local output_file="${4-}"
  local tmp
  tmp="$(mktemp)"

  local url="${HERMES_GATEWAY_PROBE_URL%/}${path}"
  if [[ -n "$data" ]]; then
    RESPONSE_CODE="$(curl -s -o "$tmp" -w "%{http_code}" -X "$method" -H "Authorization: Bearer ${HERMES_GATEWAY_API_KEY}" -H "Content-Type: application/json" "$url" --data "$data" || true)"
  else
    RESPONSE_CODE="$(curl -s -o "$tmp" -w "%{http_code}" -X "$method" -H "Authorization: Bearer ${HERMES_GATEWAY_API_KEY}" "$url" || true)"
  fi
  RESPONSE_BODY="$(cat "$tmp")"
  if [[ -n "$output_file" ]]; then
    redact_text "$RESPONSE_BODY" > "$output_file"
  fi
  rm -f "$tmp"
}

wait_http_ready() {
  local url="$1"
  local timeout_sec="$2"
  local started now code
  started="$(date +%s)"
  while true; do
    code="$(curl -sS -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${HERMES_GATEWAY_API_KEY}" "$url" || true)"
    if [[ "$code" == "200" ]]; then
      return 0
    fi
    now="$(date +%s)"
    if (( now - started >= timeout_sec )); then
      return 1
    fi
    sleep 1
  done
}

require_board_auth() {
  if [[ ${#AUTH_HEADERS[@]} -eq 0 ]]; then
    fail "board/operator auth required. Set PAPERCLIP_COOKIE, PAPERCLIP_AUTH_HEADER, or a board-capable PAPERCLIP_API_KEY."
  fi
  api_request "GET" "/companies"
  if [[ "$RESPONSE_CODE" != "200" ]]; then
    redact_text "$RESPONSE_BODY" >&2
    echo >&2
    fail "board/operator auth invalid for /api/companies (HTTP ${RESPONSE_CODE})"
  fi
}

resolve_company_id() {
  if [[ -n "$COMPANY_ID" ]]; then
    log "using company ${COMPANY_ID}"
    return
  fi

  api_request "GET" "/companies"
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
    [[ -n "$COMPANY_ID" ]] || fail "no companies found"
  fi
  log "resolved company ${COMPANY_ID}"
}

capture_container_logs() {
  mkdir -p "$HERMES_SMOKE_DIAG_DIR"
  docker logs --tail=2000 "$HERMES_CONTAINER_NAME" > "${HERMES_SMOKE_DIAG_DIR}/hermes-container.log" 2>&1 || true
  if [[ -s "${HERMES_SMOKE_DIAG_DIR}/hermes-container.log" ]]; then
    local redacted_tmp
    redacted_tmp="$(mktemp)"
    redact_text "$(cat "${HERMES_SMOKE_DIAG_DIR}/hermes-container.log")" > "$redacted_tmp"
    mv "$redacted_tmp" "${HERMES_SMOKE_DIAG_DIR}/hermes-container.log"
  fi
}

capture_run_diagnostics() {
  local run_id="$1"
  local label="${2:-run}"
  [[ -n "$run_id" ]] || return 0
  mkdir -p "$HERMES_SMOKE_DIAG_DIR"

  api_request "GET" "/heartbeat-runs/${run_id}/events?limit=1000"
  if [[ "$RESPONSE_CODE" == "200" ]]; then
    redact_text "$RESPONSE_BODY" > "${HERMES_SMOKE_DIAG_DIR}/${label}-${run_id}-events.json"
  fi

  api_request "GET" "/heartbeat-runs/${run_id}/log?limitBytes=524288"
  if [[ "$RESPONSE_CODE" == "200" ]]; then
    redact_text "$RESPONSE_BODY" > "${HERMES_SMOKE_DIAG_DIR}/${label}-${run_id}-log.json"
    jq -r '.content // ""' <<<"$RESPONSE_BODY" | while IFS= read -r line; do redact_text "$line"; echo; done > "${HERMES_SMOKE_DIAG_DIR}/${label}-${run_id}-log.txt" 2>/dev/null || true
  fi
}

capture_issue_diagnostics() {
  local issue_id="$1"
  local label="${2:-issue}"
  [[ -n "$issue_id" ]] || return 0
  mkdir -p "$HERMES_SMOKE_DIAG_DIR"

  api_request "GET" "/issues/${issue_id}"
  if [[ "$RESPONSE_CODE" == "200" ]]; then
    redact_text "$RESPONSE_BODY" > "${HERMES_SMOKE_DIAG_DIR}/${label}-${issue_id}.json"
  fi

  api_request "GET" "/issues/${issue_id}/comments"
  if [[ "$RESPONSE_CODE" == "200" ]]; then
    redact_text "$RESPONSE_BODY" > "${HERMES_SMOKE_DIAG_DIR}/${label}-${issue_id}-comments.json"
  fi
}

capture_diagnostics() {
  mkdir -p "$HERMES_SMOKE_DIAG_DIR"
  {
    echo "runSuffix=${RUN_SUFFIX}"
    echo "companyId=${COMPANY_ID:-}"
    echo "agentId=${AGENT_ID:-}"
    echo "inviteId=${INVITE_ID:-}"
    echo "joinRequestId=${JOIN_REQUEST_ID:-}"
    echo "container=${HERMES_CONTAINER_NAME}"
    echo "image=${HERMES_IMAGE}"
    echo "gateway=${HERMES_GATEWAY_API_BASE_URL}"
    echo "gatewayProbe=${HERMES_GATEWAY_PROBE_URL}"
    echo "paperclipApiUrl=${PAPERCLIP_API_URL}"
    echo "paperclipApiUrlForHermes=${PAPERCLIP_API_URL_FOR_HERMES}"
    echo "apiServerKeySha256=$(hash_prefix "${HERMES_GATEWAY_API_KEY:-}") len=${#HERMES_GATEWAY_API_KEY}"
    echo "agentApiKeySha256=$(hash_prefix "${AGENT_API_KEY:-}") len=${#AGENT_API_KEY}"
  } > "${HERMES_SMOKE_DIAG_DIR}/summary.env"

  gateway_request "GET" "/health" "" "${HERMES_SMOKE_DIAG_DIR}/gateway-health.json" || true
  gateway_request "GET" "/v1/capabilities" "" "${HERMES_SMOKE_DIAG_DIR}/gateway-capabilities.json" || true
  capture_container_logs
  capture_issue_diagnostics "$SMOKE_ISSUE_ID" "paperclip-smoke"
  capture_run_diagnostics "$RUN_ID" "paperclip-smoke"
}

cleanup_paperclip_state() {
  [[ "$KEEP_ON_EXIT" != "1" ]] || return 0

  if [[ -n "$SMOKE_ISSUE_ID" ]]; then
    log "deleting smoke issue ${SMOKE_ISSUE_ID}"
    api_request "DELETE" "/issues/${SMOKE_ISSUE_ID}"
    if [[ "$RESPONSE_CODE" != "200" && "$RESPONSE_CODE" != "404" && "$RESPONSE_CODE" != "204" ]]; then
      warn "delete issue returned HTTP ${RESPONSE_CODE}"
    fi
  fi

  if [[ -n "$AGENT_ID" ]]; then
    log "terminating/deleting smoke agent ${AGENT_ID}"
    api_request "POST" "/agents/${AGENT_ID}/terminate" "{}"
    if [[ "$RESPONSE_CODE" != "200" && "$RESPONSE_CODE" != "404" ]]; then
      warn "terminate agent returned HTTP ${RESPONSE_CODE}"
    fi
    api_request "DELETE" "/agents/${AGENT_ID}"
    if [[ "$RESPONSE_CODE" != "200" && "$RESPONSE_CODE" != "404" && "$RESPONSE_CODE" != "204" ]]; then
      warn "delete agent returned HTTP ${RESPONSE_CODE}"
    fi
  fi

  if [[ -n "$JOIN_REQUEST_ID" && -n "$COMPANY_ID" ]]; then
    api_request "POST" "/companies/${COMPANY_ID}/join-requests/${JOIN_REQUEST_ID}/reject" "{}"
    if [[ "$RESPONSE_CODE" != "200" && "$RESPONSE_CODE" != "404" && "$RESPONSE_CODE" != "409" ]]; then
      warn "reject join request returned HTTP ${RESPONSE_CODE}"
    fi
  fi
}

cleanup_local_state() {
  [[ "$KEEP_ON_EXIT" != "1" ]] || return 0

  docker rm -f "$HERMES_CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -rf "$HERMES_SMOKE_STATE_DIR"
  rm -f "$JOIN_OUTPUT_FILE"
}

on_exit() {
  local status=$?
  if [[ "$status" -ne 0 ]]; then
    KEEP_ON_EXIT=1
    warn "smoke failed; preserving diagnostics/state"
    capture_diagnostics || true
  fi

  cleanup_paperclip_state || true
  cleanup_local_state || true

  if [[ "$KEEP_ON_EXIT" == "1" ]]; then
    warn "retained diagnostics: ${HERMES_SMOKE_DIAG_DIR}"
    warn "retained state dir: ${HERMES_SMOKE_STATE_DIR}"
    warn "retained container: ${HERMES_CONTAINER_NAME}"
  fi
  exit "$status"
}
trap on_exit EXIT

build_image() {
  if [[ "$HERMES_BUILD" != "1" ]]; then
    log "HERMES_BUILD=${HERMES_BUILD}; reusing image ${HERMES_IMAGE}"
    return
  fi
  log "building Hermes gateway image ${HERMES_IMAGE} (HERMES_VERSION=${HERMES_VERSION})"
  docker build --build-arg "HERMES_VERSION=${HERMES_VERSION}" -t "$HERMES_IMAGE" "$HERMES_DOCKER_CONTEXT"
}

prepare_fresh_state() {
  mkdir -p "$HERMES_SMOKE_DIAG_DIR"
  if [[ -e "$HERMES_SMOKE_STATE_DIR" && "$HERMES_SMOKE_KEEP" != "1" ]]; then
    rm -rf "$HERMES_SMOKE_STATE_DIR"
  fi
  mkdir -p \
    "${HERMES_SMOKE_STATE_DIR}/hermes-home" \
    "${HERMES_SMOKE_STATE_DIR}/workspace" \
    "${HERMES_SMOKE_STATE_DIR}/fake-host-home/.hermes"
  chmod 700 "${HERMES_SMOKE_STATE_DIR}/hermes-home" "${HERMES_SMOKE_STATE_DIR}/workspace" || true
  echo "host hermes sentinel ${RUN_SUFFIX}" > "${HERMES_SMOKE_STATE_DIR}/fake-host-home/.hermes/host-sentinel.txt"

  if find "${HERMES_SMOKE_STATE_DIR}/hermes-home" -mindepth 1 -print -quit | grep -q .; then
    fail "Hermes state dir is not empty: ${HERMES_SMOKE_STATE_DIR}/hermes-home"
  fi
}

start_container() {
  docker rm -f "$HERMES_CONTAINER_NAME" >/dev/null 2>&1 || true

  local args=(
    run -d
    --name "$HERMES_CONTAINER_NAME"
    -p "127.0.0.1:${HERMES_GATEWAY_PORT}:8642"
    -e API_SERVER_ENABLED=true
    -e API_SERVER_KEY="$HERMES_GATEWAY_API_KEY"
    -e API_SERVER_HOST=0.0.0.0
    -e API_SERVER_PORT=8642
    -e PAPERCLIP_API_URL="$PAPERCLIP_API_URL_FOR_HERMES"
    -e NO_COLOR=1
    -v "${HERMES_SMOKE_STATE_DIR}/hermes-home:/home/hermes/.hermes"
    -v "${HERMES_SMOKE_STATE_DIR}/workspace:/home/hermes/workspace"
  )
  if [[ -n "$HERMES_SMOKE_NETWORK" ]]; then
    args+=(--network "$HERMES_SMOKE_NETWORK")
  fi
  if [[ "$HERMES_DOCKER_ADD_HOST" == "1" ]]; then
    args+=(--add-host=host.docker.internal:host-gateway)
  fi
  args+=("$HERMES_IMAGE")

  log "starting container ${HERMES_CONTAINER_NAME}"
  docker "${args[@]}" >/dev/null
}

assert_fresh_container_state() {
  log "asserting container does not see host Hermes state"
  docker exec "$HERMES_CONTAINER_NAME" sh -lc 'test ! -e "$HERMES_HOME/host-sentinel.txt"'
  docker exec "$HERMES_CONTAINER_NAME" sh -lc 'env | sort | grep -E "^(HOME|HERMES_HOME|XDG_|API_SERVER_|PAPERCLIP_API_URL)=" || true' > "${HERMES_SMOKE_DIAG_DIR}/container-env.txt"
  docker exec "$HERMES_CONTAINER_NAME" sh -lc 'find "$HERMES_HOME" -maxdepth 2 -type f -print | sort' > "${HERMES_SMOKE_DIAG_DIR}/container-hermes-home-files-before.txt" || true
  if docker exec "$HERMES_CONTAINER_NAME" sh -lc 'env | grep -q "^PAPERCLIP_API_KEY="'; then
    fail "container unexpectedly has PAPERCLIP_API_KEY before join/key claim"
  fi
}

probe_container_to_paperclip() {
  log "probing container-to-Paperclip connectivity at ${PAPERCLIP_API_URL_FOR_HERMES}/api/health"
  if ! docker exec "$HERMES_CONTAINER_NAME" curl -fsS --max-time 8 "${PAPERCLIP_API_URL_FOR_HERMES%/}/api/health" > "${HERMES_SMOKE_DIAG_DIR}/container-paperclip-health.json"; then
    fail "Hermes container cannot reach Paperclip. Set PAPERCLIP_API_URL_FOR_HERMES to a URL reachable from inside Docker, or keep HERMES_DOCKER_ADD_HOST=1 for Linux host.docker.internal."
  fi
}

probe_gateway_readiness() {
  log "waiting for Hermes gateway health at ${HERMES_GATEWAY_PROBE_URL%/}/health"
  if [[ "$HERMES_GATEWAY_PROBE_URL" != "$HERMES_GATEWAY_API_BASE_URL" ]]; then
    log "Paperclip will store Hermes gateway URL ${HERMES_GATEWAY_API_BASE_URL}"
  fi
  wait_http_ready "${HERMES_GATEWAY_PROBE_URL%/}/health" "$GATEWAY_READY_TIMEOUT_SEC" || fail "Hermes gateway health did not become ready"

  gateway_request "GET" "/health" "" "${HERMES_SMOKE_DIAG_DIR}/gateway-health.json"
  assert_status "200"

  local wrong_code
  wrong_code="$(curl -sS -o /dev/null -w "%{http_code}" -H "Authorization: Bearer wrong-smoke-key" "${HERMES_GATEWAY_PROBE_URL%/}/v1/capabilities" || true)"
  if [[ "$wrong_code" == "200" ]]; then
    fail "Hermes protected endpoint accepted a wrong API key"
  fi
}

assert_capabilities() {
  log "asserting /v1/capabilities"
  gateway_request "GET" "/v1/capabilities" "" "${HERMES_SMOKE_DIAG_DIR}/gateway-capabilities.json"
  assert_status "200"
  if ! jq -e 'type == "object"' <<<"$RESPONSE_BODY" >/dev/null; then
    fail "capabilities response is not a JSON object"
  fi
}

poll_gateway_run_terminal() {
  local run_id="$1"
  local timeout_sec="$2"
  local label="$3"
  local started now status
  started="$(date +%s)"
  while true; do
    gateway_request "GET" "/v1/runs/${run_id}" "" "${HERMES_SMOKE_DIAG_DIR}/${label}-${run_id}-status.json"
    if [[ "$RESPONSE_CODE" == "200" ]]; then
      status="$(jq -r '.status // empty' <<<"$RESPONSE_BODY")"
      case "$status" in
        completed|failed|error|cancelled|canceled|stopped|interrupted)
          echo "$status"
          return 0
          ;;
      esac
    fi
    now="$(date +%s)"
    if (( now - started >= timeout_sec )); then
      echo "timeout"
      return 0
    fi
    sleep 2
  done
}

assert_direct_gateway_run() {
  local marker="HERMES_DIRECT_OK_${RUN_SUFFIX}"
  local payload
  payload="$(jq -nc \
    --arg marker "$marker" \
    --arg session "paperclip-smoke-direct-${RUN_SUFFIX}" \
    '{input: ("Reply with exactly " + $marker + " and no other text."), instructions: "You are running a Paperclip Hermes gateway smoke direct API assertion.", session_id: $session}')"

  log "asserting POST /v1/runs and SSE events"
  gateway_request "POST" "/v1/runs" "$payload" "${HERMES_SMOKE_DIAG_DIR}/direct-run-create.json"
  assert_status "200"
  DIRECT_RUN_ID="$(jq -r '.run_id // .runId // .id // empty' <<<"$RESPONSE_BODY")"
  [[ -n "$DIRECT_RUN_ID" ]] || fail "direct run creation did not return run id"

  local events_file="${HERMES_SMOKE_DIAG_DIR}/direct-run-${DIRECT_RUN_ID}-events.sse"
  curl -sS --max-time 20 -N \
    -H "Authorization: Bearer ${HERMES_GATEWAY_API_KEY}" \
    "${HERMES_GATEWAY_PROBE_URL%/}/v1/runs/${DIRECT_RUN_ID}/events" \
    > "${events_file}.raw" || true
  redact_text "$(cat "${events_file}.raw")" > "$events_file"
  rm -f "${events_file}.raw"
  if ! grep -Eq '(^event:|^data:)' "$events_file"; then
    fail "SSE stream produced no event/data frames for direct run"
  fi

  local status
  status="$(poll_gateway_run_terminal "$DIRECT_RUN_ID" "$HERMES_DIRECT_RUN_TIMEOUT_SEC" "direct-run")"
  log "direct Hermes run ${DIRECT_RUN_ID} status=${status}"
  [[ "$status" == "completed" ]] || fail "direct Hermes run did not complete successfully (status=${status})"
}

assert_stop_behavior_if_deterministic() {
  [[ "$HERMES_STOP_ASSERT" != "0" ]] || {
    log "HERMES_STOP_ASSERT=0; skipping /stop assertion"
    return
  }

  local payload
  payload="$(jq -nc \
    --arg session "paperclip-smoke-stop-${RUN_SUFFIX}" \
    '{input: "Wait until stopped. If you cannot wait, emit a short acknowledgement.", instructions: "This run exists only to verify the Hermes gateway stop endpoint.", session_id: $session}')"

  log "probing /stop behavior (mode=${HERMES_STOP_ASSERT})"
  gateway_request "POST" "/v1/runs" "$payload" "${HERMES_SMOKE_DIAG_DIR}/stop-run-create.json"
  assert_status "200"
  STOP_RUN_ID="$(jq -r '.run_id // .runId // .id // empty' <<<"$RESPONSE_BODY")"
  [[ -n "$STOP_RUN_ID" ]] || fail "stop test run creation did not return run id"

  gateway_request "POST" "/v1/runs/${STOP_RUN_ID}/stop" "{}" "${HERMES_SMOKE_DIAG_DIR}/stop-run-stop-response.json"
  if [[ "$RESPONSE_CODE" != "200" && "$RESPONSE_CODE" != "202" && "$RESPONSE_CODE" != "204" ]]; then
    if [[ "$HERMES_STOP_ASSERT" == "auto" ]]; then
      warn "/stop returned HTTP ${RESPONSE_CODE}; treating stop assertion as non-deterministic"
      return
    fi
    fail "/stop returned HTTP ${RESPONSE_CODE}"
  fi

  local status
  status="$(poll_gateway_run_terminal "$STOP_RUN_ID" 45 "stop-run")"
  case "$status" in
    cancelled|canceled|stopped|interrupted)
      log "stop run ${STOP_RUN_ID} reached ${status}"
      ;;
    completed)
      if [[ "$HERMES_STOP_ASSERT" == "auto" ]]; then
        warn "stop run completed before cancellation could be observed; treating stop assertion as non-deterministic"
      else
        fail "stop run completed instead of stopping"
      fi
      ;;
    *)
      if [[ "$HERMES_STOP_ASSERT" == "auto" ]]; then
        warn "stop run terminal status ${status}; treating stop assertion as non-deterministic"
      else
        fail "stop run did not reach a stopped/cancelled terminal status (status=${status})"
      fi
      ;;
  esac
}

join_hermes_agent() {
  log "running join-only smoke helper"
  local join_log="${HERMES_SMOKE_DIAG_DIR}/hermes-gateway-join.log"
  HERMES_AGENT_NAME="$HERMES_AGENT_NAME" \
  HERMES_GATEWAY_API_BASE_URL="$HERMES_GATEWAY_API_BASE_URL" \
  HERMES_GATEWAY_PROBE_URL="$HERMES_GATEWAY_PROBE_URL" \
  HERMES_GATEWAY_API_KEY="$HERMES_GATEWAY_API_KEY" \
  HERMES_GATEWAY_ALLOW_INSECURE_HTTP="$HERMES_GATEWAY_ALLOW_INSECURE_HTTP" \
  HERMES_GATEWAY_SESSION_KEY_STRATEGY="$HERMES_GATEWAY_SESSION_KEY_STRATEGY" \
  HERMES_GATEWAY_TIMEOUT_SEC="$HERMES_ADAPTER_TIMEOUT_SEC" \
  PAPERCLIP_API_URL="$PAPERCLIP_API_URL" \
  PAPERCLIP_API_URL_FOR_HERMES="$PAPERCLIP_API_URL_FOR_HERMES" \
  PAPERCLIP_AUTH_HEADER="${PAPERCLIP_AUTH_HEADER:-}" \
  PAPERCLIP_API_KEY="${PAPERCLIP_API_KEY:-}" \
  PAPERCLIP_COOKIE="${PAPERCLIP_COOKIE:-}" \
  COMPANY_ID="$COMPANY_ID" \
  COMPANY_SELECTOR="$COMPANY_SELECTOR" \
  HERMES_JOIN_OUTPUT_FILE="$JOIN_OUTPUT_FILE" \
    bash scripts/smoke/hermes-gateway-join.sh > "${join_log}.raw" 2>&1 || {
      redact_text "$(cat "${join_log}.raw")" > "$join_log"
      rm -f "${join_log}.raw"
      fail "join helper failed; see ${join_log}"
    }
  redact_text "$(cat "${join_log}.raw")" > "$join_log"
  rm -f "${join_log}.raw"

  [[ -f "$JOIN_OUTPUT_FILE" ]] || fail "join helper did not write ${JOIN_OUTPUT_FILE}"
  AGENT_ID="$(jq -r '.agentId // empty' "$JOIN_OUTPUT_FILE")"
  AGENT_API_KEY="$(jq -r '.agentApiKey // empty' "$JOIN_OUTPUT_FILE")"
  INVITE_ID="$(jq -r '.inviteId // empty' "$JOIN_OUTPUT_FILE")"
  JOIN_REQUEST_ID="$(jq -r '.joinRequestId // empty' "$JOIN_OUTPUT_FILE")"
  KEY_ID="$(jq -r '.keyId // empty' "$JOIN_OUTPUT_FILE")"
  [[ -n "$AGENT_ID" && -n "$AGENT_API_KEY" ]] || fail "join output missing agent id or API key"
  log "joined Hermes gateway agent ${AGENT_ID} keyId=${KEY_ID} agentKeySha256=$(hash_prefix "$AGENT_API_KEY")"
}

install_claimed_key_in_container() {
  log "placing newly claimed Paperclip key in container workspace"
  local key_file="${HERMES_SMOKE_STATE_DIR}/workspace/paperclip-claimed-api-key.json"
  jq -nc --arg token "$AGENT_API_KEY" '{token:$token,apiKey:$token}' > "$key_file"
  # The host-created bind-mounted file must be readable by the non-root hermes
  # user inside the container. The state dir is still per-run and deleted on
  # success unless HERMES_SMOKE_KEEP=1.
  chmod 644 "$key_file"
  docker exec "$HERMES_CONTAINER_NAME" sh -lc 'test -f /home/hermes/workspace/paperclip-claimed-api-key.json && test ! -e "$HERMES_HOME/host-sentinel.txt"'
}

patch_agent_instructions_with_claimed_key() {
  log "patching Hermes agent instructions with claimed Paperclip API context"
  api_request "GET" "/agents/${AGENT_ID}"
  assert_status "200"

  local instructions patch_payload
  instructions="For this smoke run only, call Paperclip at ${PAPERCLIP_API_URL_FOR_HERMES}. Read /home/hermes/workspace/paperclip-claimed-api-key.json and use its token as PAPERCLIP_API_KEY for Paperclip API requests. Do not reveal this key. When mutating Paperclip, include X-Paperclip-Run-Id with the current Paperclip run id when available."
  patch_payload="$(jq -c --arg instructions "$instructions" '
    {adapterConfig: ((.adapterConfig // {}) + {instructions: $instructions})}
  ' <<<"$RESPONSE_BODY")"
  api_request "PATCH" "/agents/${AGENT_ID}" "$patch_payload"
  assert_status "200"
}

create_smoke_issue() {
  local marker="HERMES_PAPERCLIP_E2E_OK_${RUN_SUFFIX}"
  local title="[Hermes Gateway Smoke] ${RUN_SUFFIX}"
  local description
  description="Hermes gateway full Docker e2e smoke.\n\n1. Read this issue.\n2. Post a Paperclip issue comment containing exactly: ${marker}\n3. Mark this issue done.\n\nUse the Paperclip API URL and key provided in your run instructions. Do not reveal secrets."

  local payload
  payload="$(jq -nc \
    --arg title "$title" \
    --arg description "$description" \
    --arg assignee "$AGENT_ID" \
    '{title:$title,description:$description,status:"todo",priority:"high",assigneeAgentId:$assignee}')"
  api_request "POST" "/companies/${COMPANY_ID}/issues" "$payload"
  assert_status "201"
  SMOKE_ISSUE_ID="$(jq -r '.id // empty' <<<"$RESPONSE_BODY")"
  SMOKE_ISSUE_IDENTIFIER="$(jq -r '.identifier // empty' <<<"$RESPONSE_BODY")"
  [[ -n "$SMOKE_ISSUE_ID" ]] || fail "smoke issue create missing id"
  log "created smoke issue ${SMOKE_ISSUE_ID} (${SMOKE_ISSUE_IDENTIFIER})"
  echo "$marker" > "${HERMES_SMOKE_DIAG_DIR}/paperclip-marker.txt"
}

trigger_wakeup() {
  local payload
  payload="$(jq -nc --arg issueId "$SMOKE_ISSUE_ID" '{source:"on_demand",triggerDetail:"manual",reason:"hermes_gateway_docker_e2e_smoke",payload:{issueId:$issueId,taskId:$issueId}}')"
  api_request "POST" "/agents/${AGENT_ID}/wakeup" "$payload"
  if [[ "$RESPONSE_CODE" != "202" ]]; then
    redact_text "$RESPONSE_BODY" >&2
    echo >&2
    fail "wakeup failed (HTTP ${RESPONSE_CODE})"
  fi
  RUN_ID="$(jq -r '.id // empty' <<<"$RESPONSE_BODY")"
  [[ -n "$RUN_ID" ]] || fail "wakeup response missing run id"
  log "triggered Paperclip run ${RUN_ID}"
}

get_run_status() {
  local run_id="$1"
  api_request "GET" "/companies/${COMPANY_ID}/heartbeat-runs?agentId=${AGENT_ID}&limit=200"
  if [[ "$RESPONSE_CODE" != "200" ]]; then
    echo ""
    return 0
  fi
  jq -r --arg runId "$run_id" '.[] | select(.id == $runId) | .status' <<<"$RESPONSE_BODY" | head -n1
}

wait_for_run_terminal() {
  local run_id="$1"
  local timeout_sec="$2"
  local started now status
  started="$(date +%s)"
  while true; do
    status="$(get_run_status "$run_id")"
    if [[ "$status" == "succeeded" || "$status" == "failed" || "$status" == "timed_out" || "$status" == "cancelled" ]]; then
      echo "$status"
      return
    fi
    now="$(date +%s)"
    if (( now - started >= timeout_sec )); then
      echo "timeout"
      return
    fi
    sleep 3
  done
}

get_issue_status() {
  local issue_id="$1"
  api_request "GET" "/issues/${issue_id}"
  if [[ "$RESPONSE_CODE" != "200" ]]; then
    echo ""
    return 0
  fi
  jq -r '.status // empty' <<<"$RESPONSE_BODY"
}

wait_for_issue_terminal() {
  local issue_id="$1"
  local timeout_sec="$2"
  local started now status
  started="$(date +%s)"
  while true; do
    status="$(get_issue_status "$issue_id")"
    if [[ "$status" == "done" || "$status" == "blocked" || "$status" == "cancelled" ]]; then
      echo "$status"
      return
    fi
    now="$(date +%s)"
    if (( now - started >= timeout_sec )); then
      echo "timeout"
      return
    fi
    sleep 3
  done
}

issue_comments_contain() {
  local issue_id="$1"
  local marker="$2"
  api_request "GET" "/issues/${issue_id}/comments"
  if [[ "$RESPONSE_CODE" != "200" ]]; then
    echo "false"
    return
  fi
  jq -r --arg marker "$marker" '[.[] | (.body // "") | contains($marker)] | any' <<<"$RESPONSE_BODY"
}

assert_paperclip_wake_success() {
  local marker
  marker="$(cat "${HERMES_SMOKE_DIAG_DIR}/paperclip-marker.txt")"

  trigger_wakeup
  local run_status issue_status marker_found
  run_status="$(wait_for_run_terminal "$RUN_ID" "$RUN_TIMEOUT_SEC")"
  log "Paperclip run ${RUN_ID} status=${run_status}"
  issue_status="$(wait_for_issue_terminal "$SMOKE_ISSUE_ID" "$CASE_TIMEOUT_SEC")"
  marker_found="$(issue_comments_contain "$SMOKE_ISSUE_ID" "$marker")"
  log "smoke issue status=${issue_status} marker_found=${marker_found}"

  if [[ "$run_status" != "succeeded" || "$issue_status" != "done" || "$marker_found" != "true" ]]; then
    capture_diagnostics
  fi
  if [[ "$STRICT_CASES" == "1" ]]; then
    [[ "$run_status" == "succeeded" ]] || fail "Paperclip Hermes gateway run did not succeed"
    [[ "$issue_status" == "done" ]] || fail "smoke issue did not reach done"
    [[ "$marker_found" == "true" ]] || fail "smoke marker was not found in issue comments"
  fi
}

scan_diagnostics_for_secret_leaks() {
  [[ -n "$HERMES_GATEWAY_API_KEY" ]] || return
  log "scanning diagnostics for raw secret leaks"
  local file
  while IFS= read -r file; do
    [[ "$file" == "$JOIN_OUTPUT_FILE" ]] && continue
    if grep -Fq "$HERMES_GATEWAY_API_KEY" "$file"; then
      fail "raw Hermes gateway API key leaked in diagnostics file ${file}"
    fi
    if [[ -n "$AGENT_API_KEY" ]] && grep -Fq "$AGENT_API_KEY" "$file"; then
      fail "raw Paperclip agent API key leaked in diagnostics file ${file}"
    fi
  done < <(find "$HERMES_SMOKE_DIAG_DIR" -type f -print)
}

main() {
  log "starting Hermes gateway Docker E2E smoke"
  mkdir -p "$HERMES_SMOKE_DIAG_DIR"
  log "diagnostics dir: ${HERMES_SMOKE_DIAG_DIR}"

  require_cmd curl
  require_cmd docker
  require_cmd jq

  if [[ -z "$HERMES_GATEWAY_API_KEY" ]]; then
    HERMES_GATEWAY_API_KEY="$(generate_key)"
  fi
  log "Hermes API key sha256=$(hash_prefix "$HERMES_GATEWAY_API_KEY") len=${#HERMES_GATEWAY_API_KEY}"
  assert_gateway_api_base_url_allowed

  api_request "GET" "/health"
  assert_status "200"
  log "Paperclip health deploymentMode=$(jq -r '.deploymentMode // "unknown"' <<<"$RESPONSE_BODY") exposure=$(jq -r '.deploymentExposure // "unknown"' <<<"$RESPONSE_BODY")"
  require_board_auth
  resolve_company_id

  prepare_fresh_state
  build_image
  start_container
  assert_fresh_container_state
  probe_container_to_paperclip
  probe_gateway_readiness
  assert_capabilities
  assert_direct_gateway_run
  assert_stop_behavior_if_deterministic
  join_hermes_agent
  install_claimed_key_in_container
  patch_agent_instructions_with_claimed_key
  create_smoke_issue
  assert_paperclip_wake_success
  capture_diagnostics
  scan_diagnostics_for_secret_leaks

  log "success"
  log "companyId=${COMPANY_ID}"
  log "agentId=${AGENT_ID}"
  log "inviteId=${INVITE_ID}"
  log "joinRequestId=${JOIN_REQUEST_ID}"
  log "issueId=${SMOKE_ISSUE_ID}"
  log "issueIdentifier=${SMOKE_ISSUE_IDENTIFIER}"
  log "runId=${RUN_ID}"
  log "directHermesRunId=${DIRECT_RUN_ID}"
  log "diagnostics=${HERMES_SMOKE_DIAG_DIR}"
}

main "$@"
