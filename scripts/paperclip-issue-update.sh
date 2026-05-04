#!/usr/bin/env bash
# paperclip-issue-update.sh -- safely PATCH a Paperclip issue (status + comment).
#
# Sanctioned path for status transitions that carry a markdown comment.
# Reads the comment body from stdin / a file (never an inline argument) so
# multi-line markdown, fenced code blocks, and special characters survive
# the multi-level shell-escaping bug class that occurs when bodies are
# inlined into `node -e` / `python -c` / `curl -d` argument strings.
#
# Usage:
#   scripts/paperclip-issue-update.sh \
#     --issue-id ISSUE_ID \
#     --status STATUS \
#     [--body-file PATH] \
#     [--blocked-by ISSUE_ID]... \
#     [--dry-run]
#
# Body source (pick one): stdin (default) or --body-file PATH.
# Required env (unless --dry-run): PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_RUN_ID.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/paperclip-issue-update.sh --issue-id ISSUE_ID --status STATUS \
                                         [--body-file PATH] [--blocked-by ISSUE_ID]... [--dry-run]

Reads the update comment body from stdin by default, or from --body-file when provided.
Never pass the markdown body as an inline shell argument.

Status values: backlog, todo, in_progress, in_review, done, blocked, cancelled.
Pass --blocked-by ISSUE_ID once per blocker to set blockedByIssueIds.

--dry-run prints the JSON payload that would be sent and exits 0.
USAGE
}

issue_id="${PAPERCLIP_TASK_ID:-}"
status=""
body_file=""
dry_run=0
declare -a blocked_by=()

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
    --status) status="${2:-}"; shift 2 ;;
    --body-file) body_file="${2:-}"; shift 2 ;;
    --blocked-by) blocked_by+=("${2:-}"); shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$issue_id" ]]; then
  echo "--issue-id is required (or set PAPERCLIP_TASK_ID)" >&2
  exit 2
fi
if [[ -z "$status" ]]; then
  echo "--status is required" >&2
  exit 2
fi

comment_file="$(mktemp)"
payload_file="$(mktemp)"
blocked_file="$(mktemp)"
cleanup() { rm -f "$comment_file" "$payload_file" "$blocked_file"; }
trap cleanup EXIT

if [[ -n "$body_file" ]]; then
  if [[ ! -r "$body_file" ]]; then
    echo "--body-file '$body_file' not readable" >&2
    exit 2
  fi
  cp "$body_file" "$comment_file"
elif [[ ! -t 0 ]]; then
  cat > "$comment_file"
else
  : > "$comment_file"
fi

# Persist blockers list to a file so the inner python heredoc never sees them
# as shell-quoted argv (avoids the same escaping bug class as the comment body).
if [[ ${#blocked_by[@]} -gt 0 ]]; then
  printf '%s\n' "${blocked_by[@]}" > "$blocked_file"
else
  : > "$blocked_file"
fi

"$(resolve_python)" - "$status" "$comment_file" "$blocked_file" "$payload_file" <<'PY'
import json, pathlib, sys
status = sys.argv[1]
comment_path = pathlib.Path(sys.argv[2])
blocked_path = pathlib.Path(sys.argv[3])
out_path = pathlib.Path(sys.argv[4])

payload = {"status": status}
comment = comment_path.read_text(encoding="utf-8")
if comment.strip():
    payload["comment"] = comment
blocked = [
    line.strip()
    for line in blocked_path.read_text(encoding="utf-8").splitlines()
    if line.strip()
]
if blocked:
    payload["blockedByIssueIds"] = blocked

out_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
PY

if [[ "$dry_run" -eq 1 ]]; then
  cat "$payload_file"
  exit 0
fi

: "${PAPERCLIP_API_URL:?missing PAPERCLIP_API_URL}"
: "${PAPERCLIP_API_KEY:?missing PAPERCLIP_API_KEY}"
: "${PAPERCLIP_RUN_ID:?missing PAPERCLIP_RUN_ID}"

curl --fail-with-body -sS \
  -X PATCH \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  --data-binary "@$payload_file" \
  "$PAPERCLIP_API_URL/api/issues/$issue_id"
