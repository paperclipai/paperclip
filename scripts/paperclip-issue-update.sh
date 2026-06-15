#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/paperclip-issue-update.sh [--issue-id ID] [--status STATUS] [--comment TEXT] [--dry-run]

Reads a multiline markdown comment from stdin when stdin is piped. This preserves
newlines when building the JSON payload for PATCH /api/issues/{issueId}.

Examples:
  scripts/paperclip-issue-update.sh --issue-id "$PAPERCLIP_TASK_ID" --status in_progress <<'MD'
  Investigating formatting

  - Pulled the raw comment body
  - Comparing it with the run transcript
  MD

  scripts/paperclip-issue-update.sh --issue-id "$PAPERCLIP_TASK_ID" --status done --dry-run <<'MD'
  Done

  - Fixed the issue update helper
  MD
EOF
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

resolve_local_api_url() {
  local host="${PAPERCLIP_LISTEN_HOST:-${HOST:-127.0.0.1}}"
  local port="${PAPERCLIP_LISTEN_PORT:-${PORT:-3100}}"
  case "$host" in
    ""|"0.0.0.0"|"::") host="127.0.0.1" ;;
  esac
  if [[ "$host" == *:* && "$host" != \[* ]]; then
    host="[$host]"
  fi
  printf 'http://%s:%s' "$host" "$port"
}

api_base_candidates() {
  local seen=""
  add_candidate() {
    local candidate="${1:-}"
    candidate="${candidate%/}"
    if [[ -z "$candidate" || "$seen" == *"|$candidate|"* ]]; then
      return
    fi
    seen="${seen}|${candidate}|"
    printf '%s\n' "$candidate"
  }

  add_candidate "${PAPERCLIP_API_URL:-}"
  add_candidate "${PAPERCLIP_RUNTIME_API_URL:-}"
  if [[ -n "${PAPERCLIP_RUNTIME_API_CANDIDATES_JSON:-}" ]]; then
    while IFS= read -r candidate; do
      add_candidate "$candidate"
    done < <(jq -r '.[]? | select(type == "string" and length > 0)' <<<"$PAPERCLIP_RUNTIME_API_CANDIDATES_JSON" 2>/dev/null || true)
  fi
  add_candidate "$(resolve_local_api_url)"
}

request_issue_update() {
  local issue_id="$1"
  local payload="$2"
  local response_file error_file status_code curl_status api_base url
  local saw_failure=0
  response_file="$(mktemp)"
  error_file="$(mktemp)"

  while IFS= read -r api_base; do
    url="${api_base%/}/api/issues/$issue_id"
    : >"$response_file"
    : >"$error_file"
    set +e
    status_code="$(
      curl -sS -X PATCH -w '%{http_code}' -o "$response_file" \
        "$url" \
        -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
        -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
        -H 'Content-Type: application/json' \
        --data-binary "$payload" \
        2>"$error_file"
    )"
    curl_status=$?
    set -e

    if [[ "$curl_status" -ne 0 ]]; then
      saw_failure=1
      continue
    fi

    if [[ "$status_code" -lt 200 || "$status_code" -ge 300 ]]; then
      printf 'Issue update failed (%s): %s\n' "$status_code" "$url" >&2
      cat "$response_file" >&2
      printf '\n' >&2
      rm -f "$response_file" "$error_file"
      exit 1
    fi

    if [[ "$saw_failure" == "1" ]]; then
      printf 'Paperclip API primary URL was unavailable; used fallback %s.\n' "$api_base" >&2
    fi
    cat "$response_file"
    rm -f "$response_file" "$error_file"
    return 0
  done < <(api_base_candidates)

  printf 'Could not reach the Paperclip API using configured or local runtime URLs.\n' >&2
  if [[ -s "$error_file" ]]; then
    cat "$error_file" >&2
  fi
  rm -f "$response_file" "$error_file"
  exit 1
}

issue_id="${PAPERCLIP_TASK_ID:-}"
status=""
comment_arg=""
dry_run=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue-id)
      issue_id="${2:-}"
      shift 2
      ;;
    --status)
      status="${2:-}"
      shift 2
      ;;
    --comment)
      comment_arg="${2:-}"
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$issue_id" ]]; then
  printf 'Missing issue id. Pass --issue-id or set PAPERCLIP_TASK_ID.\n' >&2
  exit 1
fi

comment=""
if [[ -n "$comment_arg" ]]; then
  comment="$comment_arg"
elif [[ ! -t 0 ]]; then
  comment="$(cat)"
fi

require_command jq

payload="$(
  jq -nc \
    --arg status "$status" \
    --arg comment "$comment" \
    '
      (if $status == "" then {} else {status: $status} end) +
      (if $comment == "" then {} else {comment: $comment} end)
    '
)"

if [[ "$dry_run" == "1" ]]; then
  printf '%s\n' "$payload"
  exit 0
fi

if [[ -z "${PAPERCLIP_API_KEY:-}" || -z "${PAPERCLIP_RUN_ID:-}" ]]; then
  printf 'Missing PAPERCLIP_API_KEY or PAPERCLIP_RUN_ID.\n' >&2
  exit 1
fi

request_issue_update "$issue_id" "$payload"
