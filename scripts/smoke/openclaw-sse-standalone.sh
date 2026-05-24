#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[openclaw-sse-standalone] $*"
}

fail() {
  echo "[openclaw-sse-standalone] ERROR: $*" >&2
  exit 1
}

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || fail "missing required command: $cmd"
}

require_cmd curl
require_cmd jq
require_cmd grep

OPENCLAW_URL="${OPENCLAW_URL:-}"
OPENCLAW_METHOD="${OPENCLAW_METHOD:-POST}"
OPENCLAW_AUTH_HEADER="${OPENCLAW_AUTH_HEADER:-}"
OPENCLAW_TIMEOUT_SEC="${OPENCLAW_TIMEOUT_SEC:-180}"
OPENCLAW_MODEL="${OPENCLAW_MODEL:-openclaw}"
OPENCLAW_USER="${OPENCLAW_USER:-valadrien-os-smoke}"

VALADRIEN_OS_RUN_ID="${VALADRIEN_OS_RUN_ID:-smoke-run-$(date +%s)}"
VALADRIEN_OS_AGENT_ID="${VALADRIEN_OS_AGENT_ID:-openclaw-smoke-agent}"
VALADRIEN_OS_COMPANY_ID="${VALADRIEN_OS_COMPANY_ID:-openclaw-smoke-company}"
VALADRIEN_OS_API_URL="${VALADRIEN_OS_API_URL:-http://localhost:3100}"
VALADRIEN_OS_TASK_ID="${VALADRIEN_OS_TASK_ID:-openclaw-smoke-task}"
VALADRIEN_OS_WAKE_REASON="${VALADRIEN_OS_WAKE_REASON:-openclaw_smoke_test}"
VALADRIEN_OS_WAKE_COMMENT_ID="${VALADRIEN_OS_WAKE_COMMENT_ID:-}"
VALADRIEN_OS_APPROVAL_ID="${VALADRIEN_OS_APPROVAL_ID:-}"
VALADRIEN_OS_APPROVAL_STATUS="${VALADRIEN_OS_APPROVAL_STATUS:-}"
VALADRIEN_OS_LINKED_ISSUE_IDS="${VALADRIEN_OS_LINKED_ISSUE_IDS:-}"
OPENCLAW_TEXT_PREFIX="${OPENCLAW_TEXT_PREFIX:-Standalone OpenClaw SSE smoke test.}"

[[ -n "$OPENCLAW_URL" ]] || fail "OPENCLAW_URL is required"

read -r -d '' TEXT_BODY <<EOF || true
${OPENCLAW_TEXT_PREFIX}

VALADRIEN_OS_RUN_ID=${VALADRIEN_OS_RUN_ID}
VALADRIEN_OS_AGENT_ID=${VALADRIEN_OS_AGENT_ID}
VALADRIEN_OS_COMPANY_ID=${VALADRIEN_OS_COMPANY_ID}
VALADRIEN_OS_API_URL=${VALADRIEN_OS_API_URL}
VALADRIEN_OS_TASK_ID=${VALADRIEN_OS_TASK_ID}
VALADRIEN_OS_WAKE_REASON=${VALADRIEN_OS_WAKE_REASON}
VALADRIEN_OS_WAKE_COMMENT_ID=${VALADRIEN_OS_WAKE_COMMENT_ID}
VALADRIEN_OS_APPROVAL_ID=${VALADRIEN_OS_APPROVAL_ID}
VALADRIEN_OS_APPROVAL_STATUS=${VALADRIEN_OS_APPROVAL_STATUS}
VALADRIEN_OS_LINKED_ISSUE_IDS=${VALADRIEN_OS_LINKED_ISSUE_IDS}

Run your Valadrien OS heartbeat procedure now.
EOF

PAYLOAD="$(jq -nc \
  --arg text "$TEXT_BODY" \
  --arg model "$OPENCLAW_MODEL" \
  --arg user "$OPENCLAW_USER" \
  --arg runId "$VALADRIEN_OS_RUN_ID" \
  --arg agentId "$VALADRIEN_OS_AGENT_ID" \
  --arg companyId "$VALADRIEN_OS_COMPANY_ID" \
  --arg apiUrl "$VALADRIEN_OS_API_URL" \
  --arg taskId "$VALADRIEN_OS_TASK_ID" \
  --arg wakeReason "$VALADRIEN_OS_WAKE_REASON" \
  --arg wakeCommentId "$VALADRIEN_OS_WAKE_COMMENT_ID" \
  --arg approvalId "$VALADRIEN_OS_APPROVAL_ID" \
  --arg approvalStatus "$VALADRIEN_OS_APPROVAL_STATUS" \
  --arg linkedIssueIds "$VALADRIEN_OS_LINKED_ISSUE_IDS" \
  '{
    model: $model,
    user: $user,
    input: $text,
    stream: true,
    metadata: {
      VALADRIEN_OS_RUN_ID: $runId,
      VALADRIEN_OS_AGENT_ID: $agentId,
      VALADRIEN_OS_COMPANY_ID: $companyId,
      VALADRIEN_OS_API_URL: $apiUrl,
      VALADRIEN_OS_TASK_ID: $taskId,
      VALADRIEN_OS_WAKE_REASON: $wakeReason,
      VALADRIEN_OS_WAKE_COMMENT_ID: $wakeCommentId,
      VALADRIEN_OS_APPROVAL_ID: $approvalId,
      VALADRIEN_OS_APPROVAL_STATUS: $approvalStatus,
      VALADRIEN_OS_LINKED_ISSUE_IDS: $linkedIssueIds,
      valadrien_os_session_key: ("valadrien-os:run:" + $runId)
    }
  }')"

headers_file="$(mktemp)"
body_file="$(mktemp)"
cleanup() {
  rm -f "$headers_file" "$body_file"
}
trap cleanup EXIT

args=(
  -sS
  -N
  --max-time "$OPENCLAW_TIMEOUT_SEC"
  -X "$OPENCLAW_METHOD"
  -H "content-type: application/json"
  -H "accept: text/event-stream"
  -H "x-openclaw-session-key: valadrien-os:run:${VALADRIEN_OS_RUN_ID}"
  -D "$headers_file"
  -o "$body_file"
  --data "$PAYLOAD"
  "$OPENCLAW_URL"
)

if [[ -n "$OPENCLAW_AUTH_HEADER" ]]; then
  args=(-H "Authorization: $OPENCLAW_AUTH_HEADER" "${args[@]}")
fi

log "posting SSE wake payload to ${OPENCLAW_URL}"
http_code="$(curl "${args[@]}" -w "%{http_code}")"
log "http status: ${http_code}"

if [[ ! "$http_code" =~ ^2 ]]; then
  tail -n 80 "$body_file" >&2 || true
  fail "non-success HTTP status: ${http_code}"
fi

if ! grep -Eqi '^content-type:.*text/event-stream' "$headers_file"; then
  tail -n 40 "$body_file" >&2 || true
  fail "response content-type was not text/event-stream"
fi

if grep -Eqi 'event:\s*(error|failed|cancel)|"status":"(failed|cancelled|error)"|"type":"[^"]*(failed|cancelled|error)"' "$body_file"; then
  tail -n 120 "$body_file" >&2 || true
  fail "stream reported a failure event"
fi

if ! grep -Eqi 'event:\s*(done|completed|response\.completed)|\[DONE\]|"status":"(completed|succeeded|done)"|"type":"response\.completed"' "$body_file"; then
  tail -n 120 "$body_file" >&2 || true
  fail "stream ended without a terminal completion marker"
fi

event_count="$(grep -Ec '^event:' "$body_file" || true)"
log "stream completed successfully (events=${event_count})"
echo
tail -n 40 "$body_file"
