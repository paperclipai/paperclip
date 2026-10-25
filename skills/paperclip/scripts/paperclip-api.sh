#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat >&2 <<'EOF2'
Usage:
  scripts/paperclip-api.sh METHOD /api/PATH [JSON | @FILE | -]

Calls any Paperclip API route with auth and run-id headers. The body is inline
JSON, a file (@body.json), or stdin (-). Exits non-zero on HTTP >= 400 or an
empty write response, and prints the server response on stderr in that case.

Examples:
  scripts/paperclip-api.sh GET /api/agents/me/inbox-lite
  scripts/paperclip-api.sh POST "/api/issues/$PAPERCLIP_TASK_ID/checkout" '{"agentId":"...","expectedStatuses":["todo"]}'
  jq -n '{title: "Follow-up"}' | scripts/paperclip-api.sh POST "/api/companies/$PAPERCLIP_COMPANY_ID/issues" -
EOF2
  exit 2
}

[[ $# -ge 2 && $# -le 3 ]] || usage
method=$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')
path=$2
body=${3:-}
[[ $path == /* ]] || usage

base="${PAPERCLIP_API_URL:?Missing PAPERCLIP_API_URL}"
base="${base%/}"
base="${base%/api}"
: "${PAPERCLIP_API_KEY:?Missing PAPERCLIP_API_KEY}"

state_dir=${PAPERCLIP_HELPER_STATE_DIR:-${PAPERCLIP_WORKSPACE_CWD:-$PWD}/.paperclip/api-helper}
response_file=$(umask 077; mkdir -p "$state_dir" && mktemp "$state_dir/response.XXXXXX")
trap 'rm -f "$response_file"' EXIT

args=(-sS -m 60 -X "$method" -o "$response_file" -w '%{http_code}')
if [[ -n ${PAPERCLIP_RUN_ID:-} ]]; then
  args+=(-H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID")
fi
if [[ $body == - ]]; then
  body=@-
fi
if [[ -n $body ]]; then
  args+=(-H 'Content-Type: application/json' --data-binary "$body")
fi

set +e
http_code=$(curl -K <(printf 'header = "Authorization: Bearer %s"\n' "$PAPERCLIP_API_KEY") "${args[@]}" "$base$path")
curl_exit=$?
set -e

cat "$response_file"
if [[ $curl_exit -ne 0 || ${http_code:-0} -ge 400 || ${http_code:-0} -eq 0 ]] || [[ $method != GET && $method != DELETE && ! -s $response_file ]]; then
  detail=$(head -c 4000 "$response_file" | tr -d '\0')
  printf '%s %s FAILED (curl exit %s, HTTP %s): %s\n' "$method" "$path" "$curl_exit" "${http_code:-000}" "${detail:-<empty response>}" >&2
  exit 1
fi
