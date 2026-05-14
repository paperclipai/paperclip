#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/paperclip-issue-comment.sh [--issue-id ID] [--body TEXT] [--dry-run]

Posts a comment to POST /api/issues/{issueId}/comments. Prefer stdin/heredoc
input for comment bodies; it preserves newlines and avoids accidental shell
expansion in inline JSON or double-quoted shell strings.

Examples:
  scripts/paperclip-issue-comment.sh --issue-id "$PAPERCLIP_TASK_ID" <<'MD'
  Update

  - Verified the comment body keeps line breaks
  - Literal examples like $(command), ${VAR}, and `code` remain data
  MD

  scripts/paperclip-issue-comment.sh --issue-id "$PAPERCLIP_TASK_ID" --dry-run <<'MD'
  Dry-run comment
  MD
EOF
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

guard_inline_body() {
  local value="$1"
  if [[ "$value" == *$'\n'* || "$value" == *'$('* || "$value" == *'${'* || "$value" == *'`'* ]]; then
    cat >&2 <<'EOF'
Refusing shell-risky --body content.

Pass multiline or shell-looking markdown via stdin/heredoc instead, for example:

  scripts/paperclip-issue-comment.sh --issue-id "$PAPERCLIP_TASK_ID" <<'MD'
  Update

  - Literal examples like $(command), ${VAR}, and `code` remain data here.
  MD
EOF
    exit 2
  fi
}

issue_id="${PAPERCLIP_TASK_ID:-}"
body_arg=""
body_from_arg=0
dry_run=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue-id)
      issue_id="${2:-}"
      shift 2
      ;;
    --body)
      body_arg="${2:-}"
      body_from_arg=1
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

body=""
if [[ "$body_from_arg" == "1" ]]; then
  guard_inline_body "$body_arg"
  body="$body_arg"
elif [[ ! -t 0 ]]; then
  body="$(cat)"
fi

if [[ -z "$body" ]]; then
  printf 'Missing comment body. Pass --body or pipe stdin.\n' >&2
  exit 1
fi

require_command jq

payload="$(jq -nc --arg body "$body" '{body: $body}')"

if [[ "$dry_run" == "1" ]]; then
  printf '%s\n' "$payload"
  exit 0
fi

if [[ -z "${PAPERCLIP_API_URL:-}" || -z "${PAPERCLIP_API_KEY:-}" || -z "${PAPERCLIP_RUN_ID:-}" ]]; then
  printf 'Missing PAPERCLIP_API_URL, PAPERCLIP_API_KEY, or PAPERCLIP_RUN_ID.\n' >&2
  exit 1
fi

curl -sS -X POST \
  "$PAPERCLIP_API_URL/api/issues/$issue_id/comments" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H 'Content-Type: application/json' \
  --data-binary "$payload"
