#!/usr/bin/env bash
# agent-comment.sh
# Post a markdown comment to a Paperclip issue, preserving newlines correctly.
# Exits 0 on success, 1 on error.
#
# Usage:
#   agent-comment.sh <issue-id-or-identifier> <comment-body>
#
# Or pipe the comment body:
#   echo "My comment" | agent-comment.sh <issue-id-or-identifier>
#
# The issue ID can be a UUID or an identifier like LINAA-42.
# If an identifier is given, the issue is looked up first.

set -euo pipefail

ISSUE_REF="${1:?Usage: agent-comment.sh <issue-id-or-identifier> [comment-body]}"
BODY="${2:-}"

API_URL="${PAPERCLIP_API_URL:?PAPERCLIP_API_URL is not set}"
API_KEY="${PAPERCLIP_API_KEY:?PAPERCLIP_API_KEY is not set}"
RUN_ID="${PAPERCLIP_RUN_ID:-}"

# If body not passed as arg, read from stdin
if [ -z "$BODY" ]; then
  BODY=$(cat)
fi

if [ -z "$BODY" ]; then
  echo "ERROR: Comment body is empty" >&2
  exit 1
fi

# Resolve to a UUID if given an identifier (LINAA-42 style)
if [[ "$ISSUE_REF" =~ ^[A-Z]+-[0-9]+$ ]]; then
  issue_data=$(curl -fs \
    -H "Authorization: Bearer $API_KEY" \
    "$API_URL/api/issues/$ISSUE_REF")
  ISSUE_ID=$(echo "$issue_data" | jq -r '.id // empty')
  if [ -z "$ISSUE_ID" ]; then
    echo "ERROR: Could not resolve identifier $ISSUE_REF to an issue ID" >&2
    exit 1
  fi
else
  ISSUE_ID="$ISSUE_REF"
fi

# Build JSON safely — jq handles all escaping
payload=$(jq -n --arg body "$BODY" '{body: $body}')

headers=(-H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json")
if [ -n "$RUN_ID" ]; then
  headers+=(-H "X-Paperclip-Run-Id: $RUN_ID")
fi

response=$(curl -fs -X POST \
  "${headers[@]}" \
  -d "$payload" \
  "$API_URL/api/issues/$ISSUE_ID/comments")

if [ $? -ne 0 ]; then
  echo "ERROR: Failed to post comment to $ISSUE_REF" >&2
  echo "$response" >&2
  exit 1
fi

comment_id=$(echo "$response" | jq -r '.id // empty')
echo "Comment posted: $comment_id"
