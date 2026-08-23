#!/usr/bin/env bash
# Usage: paperclip-issue-update.sh --issue-id <id> --status done [--priority high] <<'MD'
# Body of comment comes from stdin.
set -euo pipefail

ISSUE_ID=""
STATUS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue-id) ISSUE_ID="$2"; shift 2 ;;
    --status) STATUS="$2"; shift 2 ;;
    *) echo "unknown arg $1"; exit 1 ;;
  esac
done

if [[ -z "$ISSUE_ID" || -z "$STATUS" ]]; then
  echo "usage: $0 --issue-id <id> --status <done|in_review|blocked|in_progress|todo>" >&2
  exit 1
fi

if [[ -z "${PAPERCLIP_API_URL:-}" || -z "${PAPERCLIP_API_KEY:-}" || -z "${PAPERCLIP_RUN_ID:-}" ]]; then
  echo "PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_RUN_ID required" >&2
  exit 1
fi

COMMENT_BODY="$(cat)"

export __PC_COMMENT="$COMMENT_BODY"
python3 - "$STATUS" "$ISSUE_ID" <<'PY' > /tmp/pc_issue_update.json
import json, sys, os
status = sys.argv[1]
comment = os.environ["__PC_COMMENT"]
print(json.dumps({"status": status, "comment": comment}))
PY

PAYLOAD_FILE=/tmp/pc_issue_update.json
echo "PATCH issue $ISSUE_ID status=$STATUS (comment $(wc -c < $PAYLOAD_FILE) bytes)" >&2
curl -s -X PATCH \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  --data @"$PAYLOAD_FILE" \
  "$PAPERCLIP_API_URL/api/issues/$ISSUE_ID" | head -c 500
echo
