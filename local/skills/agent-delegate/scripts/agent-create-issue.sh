#!/usr/bin/env bash
# agent-create-issue.sh
# Create a Paperclip issue and print its identifier (e.g. LINAA-42) on stdout.
# Exits 0 on success, 1 on error.
#
# Usage: agent-create-issue.sh --title <title> --assignee <agent-id> [options]
#
# Options:
#   --title       <string>   Issue title (required)
#   --assignee    <uuid>     Assignee agent ID (required)
#   --status      <string>   Initial status (default: todo)
#   --parent      <uuid>     Parent issue ID (optional)
#   --project     <uuid>     Project ID (optional)
#   --description <string>   Issue description body (optional)
#   --origin-kind <string>   Declarable origin kind, e.g. health_check or intent:* (optional)

set -euo pipefail

API_URL="${PAPERCLIP_API_URL:?PAPERCLIP_API_URL is not set}"
API_KEY="${PAPERCLIP_API_KEY:?PAPERCLIP_API_KEY is not set}"
COMPANY_ID="${PAPERCLIP_COMPANY_ID:?PAPERCLIP_COMPANY_ID is not set}"
RUN_ID="${PAPERCLIP_RUN_ID:-}"

TITLE=""
ASSIGNEE=""
STATUS="todo"
PARENT=""
PROJECT=""
DESCRIPTION=""
ORIGIN_KIND=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)       TITLE="$2";       shift 2 ;;
    --assignee)    ASSIGNEE="$2";    shift 2 ;;
    --status)      STATUS="$2";      shift 2 ;;
    --parent)      PARENT="$2";      shift 2 ;;
    --project)     PROJECT="$2";     shift 2 ;;
    --description) DESCRIPTION="$2"; shift 2 ;;
    --origin-kind) ORIGIN_KIND="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$TITLE" ] || [ -z "$ASSIGNEE" ]; then
  echo "ERROR: --title and --assignee are required" >&2
  exit 1
fi

# Build JSON payload
payload=$(jq -n \
  --arg title       "$TITLE" \
  --arg assignee    "$ASSIGNEE" \
  --arg status      "$STATUS" \
  --arg parent      "$PARENT" \
  --arg project     "$PROJECT" \
  --arg description "$DESCRIPTION" \
  --arg origin_kind "$ORIGIN_KIND" \
  '{
    title: $title,
    assigneeAgentId: $assignee,
    status: $status
  }
  | if $parent != "" then . + {parentId: $parent} else . end
  | if $project != "" then . + {projectId: $project} else . end
  | if $description != "" then . + {description: $description} else . end
  | if $origin_kind != "" then . + {originKind: $origin_kind} else . end
  ')

# Extra headers
headers=(-H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json")
if [ -n "$RUN_ID" ]; then
  headers+=(-H "X-Paperclip-Run-Id: $RUN_ID")
fi

response=$(curl -fs -X POST \
  "${headers[@]}" \
  -d "$payload" \
  "$API_URL/api/companies/$COMPANY_ID/issues")

if [ $? -ne 0 ]; then
  echo "ERROR: Issue creation API call failed" >&2
  echo "$response" >&2
  exit 1
fi

identifier=$(echo "$response" | jq -r '.identifier // empty')
if [ -z "$identifier" ]; then
  echo "ERROR: Issue created but no identifier returned — creation may have failed" >&2
  echo "$response" >&2
  exit 1
fi

# Print identifier and full response to stdout (identifier on first line)
echo "$identifier"
echo "$response"
