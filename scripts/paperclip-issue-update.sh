#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  paperclip-issue-update [--issue-id ID] [--status STATUS] [--comment TEXT] [--dry-run]
  scripts/paperclip-issue-update.sh [--issue-id ID] [--status STATUS] [--comment TEXT] [--dry-run]

Reads a multiline markdown comment from stdin when stdin is piped. This preserves
newlines when building the JSON payload for PATCH /api/issues/{issueId}.

The helper intentionally uses Node for JSON encoding instead of jq because jq is
not installed in every agent runtime.

Examples:
  paperclip-issue-update --issue-id "$PAPERCLIP_TASK_ID" --status in_progress <<'MD'
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

issue_id="${PAPERCLIP_TASK_ID:-}"
status=""
comment_arg=""
comment_arg_set=0
dry_run=0
comment_file=""

cleanup() {
  if [[ -n "$comment_file" && -f "$comment_file" ]]; then
    rm -f "$comment_file"
  fi
}
trap cleanup EXIT

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
      comment_arg_set=1
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

has_comment=0
if [[ "$comment_arg_set" == "1" ]]; then
  comment_file="$(mktemp)"
  printf '%s' "$comment_arg" >"$comment_file"
  has_comment=1
elif [[ ! -t 0 ]]; then
  comment_file="$(mktemp)"
  cat >"$comment_file"
  if [[ -s "$comment_file" ]]; then
    has_comment=1
  fi
fi

require_command node

payload="$(
  PAPERCLIP_ISSUE_UPDATE_STATUS="$status" \
  PAPERCLIP_ISSUE_UPDATE_HAS_COMMENT="$has_comment" \
  PAPERCLIP_ISSUE_UPDATE_COMMENT_FILE="$comment_file" \
  node <<'NODE'
const fs = require("fs");

const payload = {};
const status = process.env.PAPERCLIP_ISSUE_UPDATE_STATUS || "";

if (status) {
  payload.status = status;
}

if (process.env.PAPERCLIP_ISSUE_UPDATE_HAS_COMMENT === "1") {
  const commentFile = process.env.PAPERCLIP_ISSUE_UPDATE_COMMENT_FILE;
  payload.comment = fs.readFileSync(commentFile, "utf8");
}

process.stdout.write(JSON.stringify(payload));
NODE
)"

if [[ "$dry_run" == "1" ]]; then
  printf '%s\n' "$payload"
  exit 0
fi

if [[ -z "${PAPERCLIP_API_URL:-}" || -z "${PAPERCLIP_API_KEY:-}" || -z "${PAPERCLIP_RUN_ID:-}" ]]; then
  printf 'Missing PAPERCLIP_API_URL, PAPERCLIP_API_KEY, or PAPERCLIP_RUN_ID.\n' >&2
  exit 1
fi

require_command curl

curl -sS -X PATCH \
  "$PAPERCLIP_API_URL/api/issues/$issue_id" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H 'Content-Type: application/json' \
  --data-binary "$payload"
