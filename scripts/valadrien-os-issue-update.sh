#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/valadrien-os-issue-update.sh [--issue-id ID] [--status STATUS] [--comment TEXT] [--dry-run]

Reads a multiline markdown comment from stdin when stdin is piped. This preserves
newlines when building the JSON payload for PATCH /api/issues/{issueId}.

Examples:
  scripts/valadrien-os-issue-update.sh --issue-id "$VALADRIEN_OS_TASK_ID" --status in_progress <<'MD'
  Investigating formatting

  - Pulled the raw comment body
  - Comparing it with the run transcript
  MD

  scripts/valadrien-os-issue-update.sh --issue-id "$VALADRIEN_OS_TASK_ID" --status done --dry-run <<'MD'
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

issue_id="${VALADRIEN_OS_TASK_ID:-}"
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
  printf 'Missing issue id. Pass --issue-id or set VALADRIEN_OS_TASK_ID.\n' >&2
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

if [[ -z "${VALADRIEN_OS_API_URL:-}" || -z "${VALADRIEN_OS_API_KEY:-}" || -z "${VALADRIEN_OS_RUN_ID:-}" ]]; then
  printf 'Missing VALADRIEN_OS_API_URL, VALADRIEN_OS_API_KEY, or VALADRIEN_OS_RUN_ID.\n' >&2
  exit 1
fi

curl -sS -X PATCH \
  "$VALADRIEN_OS_API_URL/api/issues/$issue_id" \
  -H "Authorization: Bearer $VALADRIEN_OS_API_KEY" \
  -H "X-Valadrien-Os-Run-Id: $VALADRIEN_OS_RUN_ID" \
  -H 'Content-Type: application/json' \
  --data-binary "$payload"
