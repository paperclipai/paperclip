#!/usr/bin/env bash
# agent-list-reports.sh
# Print the direct reports of the current agent as a JSON array.
# Exits 0 on success, 1 on error.
#
# Usage: agent-list-reports.sh [agent-id]
#   agent-id defaults to $PAPERCLIP_AGENT_ID

set -euo pipefail

AGENT_ID="${1:-${PAPERCLIP_AGENT_ID:?PAPERCLIP_AGENT_ID is not set}}"
API_URL="${PAPERCLIP_API_URL:?PAPERCLIP_API_URL is not set}"
API_KEY="${PAPERCLIP_API_KEY:?PAPERCLIP_API_KEY is not set}"
COMPANY_ID="${PAPERCLIP_COMPANY_ID:?PAPERCLIP_COMPANY_ID is not set}"

response=$(curl -fs \
  -H "Authorization: Bearer $API_KEY" \
  "$API_URL/api/companies/$COMPANY_ID/agents?reportsTo=$AGENT_ID")

if [ $? -ne 0 ]; then
  echo "ERROR: Failed to fetch direct reports from API" >&2
  exit 1
fi

# Verify it's a JSON array
count=$(echo "$response" | jq 'length' 2>/dev/null)
if [ -z "$count" ]; then
  echo "ERROR: API response was not a valid JSON array" >&2
  echo "$response" >&2
  exit 1
fi

echo "$response"
