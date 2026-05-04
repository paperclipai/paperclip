#!/usr/bin/env bash
# agent-poll-issue.sh
# Poll a Paperclip issue until it reaches a terminal status (done/cancelled),
# then print the final status and elapsed seconds to stdout.
# Exits 0 on success (done/cancelled), 1 on timeout or API error.
#
# Usage: agent-poll-issue.sh <identifier-or-id> [timeout-seconds] [interval-seconds]
#   identifier-or-id  e.g. LINAA-42 or a UUID
#   timeout-seconds   default: 600 (10 min)
#   interval-seconds  default: 30

set -euo pipefail

IDENTIFIER="${1:?Usage: agent-poll-issue.sh <identifier> [timeout] [interval]}"
TIMEOUT="${2:-600}"
INTERVAL="${3:-30}"

API_URL="${PAPERCLIP_API_URL:?PAPERCLIP_API_URL is not set}"
API_KEY="${PAPERCLIP_API_KEY:?PAPERCLIP_API_KEY is not set}"

start_time=$(date +%s)
deadline=$((start_time + TIMEOUT))

echo "Polling $IDENTIFIER (timeout=${TIMEOUT}s, interval=${INTERVAL}s)" >&2

while true; do
  now=$(date +%s)
  if [ "$now" -ge "$deadline" ]; then
    elapsed=$((now - start_time))
    echo "TIMEOUT after ${elapsed}s — $IDENTIFIER did not complete" >&2
    exit 1
  fi

  response=$(curl -fs \
    -H "Authorization: Bearer $API_KEY" \
    "$API_URL/api/issues/$IDENTIFIER" 2>/dev/null) || {
    echo "WARNING: API call failed for $IDENTIFIER, retrying..." >&2
    sleep "$INTERVAL"
    continue
  }

  status=$(echo "$response" | jq -r '.status // empty')
  if [ -z "$status" ]; then
    echo "WARNING: Could not parse status from response, retrying..." >&2
    sleep "$INTERVAL"
    continue
  fi

  elapsed=$(( $(date +%s) - start_time ))
  echo "[$IDENTIFIER] status=$status elapsed=${elapsed}s" >&2

  if [ "$status" = "done" ] || [ "$status" = "cancelled" ]; then
    echo "status=$status"
    echo "elapsed=${elapsed}"
    echo "identifier=$IDENTIFIER"
    exit 0
  fi

  sleep "$INTERVAL"
done
