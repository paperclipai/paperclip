#!/usr/bin/env bash
# paperclip-issue-comment.sh -- safely post a markdown comment on a Paperclip issue.
#
# This is the sanctioned path for an agent to post a comment from shell.
# Reading the body from stdin / a file (never an inline argument) eliminates the
# multi-level shell-escaping bugs that have repeatedly produced collapsed,
# truncated, or syntactically broken comments when markdown bodies are inlined
# into `node -e` / `python -c` / `curl -d` argument strings.
#
# Usage:
#   scripts/paperclip-issue-comment.sh --issue-id ISSUE_ID [--body-file PATH] [--dry-run]
#
# Body source (pick one):
#   - default: read body from stdin (heredoc-friendly)
#   - --body-file PATH: read body from a file
#
# Required env (unless --dry-run):
#   PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_RUN_ID
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/paperclip-issue-comment.sh --issue-id ISSUE_ID [--body-file PATH] [--dry-run]

Reads the comment body from stdin by default, or from --body-file when provided.
Never pass the markdown body as an inline shell argument.

Required env (live mode): PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_RUN_ID.

--dry-run prints the JSON payload that would be sent and exits 0.
USAGE
}

issue_id=""
body_file=""
dry_run=0

resolve_python() {
  # Probe each candidate by actually running it. On Windows, `python3` may
  # resolve to a Microsoft Store stub that fails on use; PATH lookup alone is
  # not enough.
  for candidate in python3 python py; do
    if command -v "$candidate" >/dev/null 2>&1 \
        && "$candidate" -c "import sys" >/dev/null 2>&1; then
      echo "$candidate"
      return
    fi
  done
  echo "Missing working python3/python/py interpreter on PATH" >&2
  exit 127
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue-id) issue_id="${2:-}"; shift 2 ;;
    --body-file) body_file="${2:-}"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$issue_id" ]]; then
  echo "--issue-id is required" >&2
  exit 2
fi

comment_file="$(mktemp)"
payload_file="$(mktemp)"
cleanup() { rm -f "$comment_file" "$payload_file"; }
trap cleanup EXIT

if [[ -n "$body_file" ]]; then
  if [[ ! -r "$body_file" ]]; then
    echo "--body-file '$body_file' not readable" >&2
    exit 2
  fi
  cp "$body_file" "$comment_file"
else
  cat > "$comment_file"
fi

if [[ ! -s "$comment_file" ]]; then
  echo "Comment body is empty (stdin or --body-file produced no content)" >&2
  exit 2
fi

# Build the JSON payload with python's json module so newlines, backticks,
# fenced code blocks, and unicode survive verbatim.
"$(resolve_python)" - "$comment_file" "$payload_file" <<'PY'
import json, pathlib, sys
body = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
pathlib.Path(sys.argv[2]).write_text(
    json.dumps({"body": body}, ensure_ascii=False),
    encoding="utf-8",
)
PY

if [[ "$dry_run" -eq 1 ]]; then
  cat "$payload_file"
  exit 0
fi

: "${PAPERCLIP_API_URL:?missing PAPERCLIP_API_URL}"
: "${PAPERCLIP_API_KEY:?missing PAPERCLIP_API_KEY}"
: "${PAPERCLIP_RUN_ID:?missing PAPERCLIP_RUN_ID}"

curl --fail-with-body -sS \
  -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  --data-binary "@$payload_file" \
  "$PAPERCLIP_API_URL/api/issues/$issue_id/comments"
