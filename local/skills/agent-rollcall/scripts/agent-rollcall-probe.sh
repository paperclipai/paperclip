#!/usr/bin/env bash
# agent-rollcall-probe.sh
# Create a standardised rollcall probe issue for a single direct report.
# Wraps agent-create-issue.sh with a fixed title and description template so
# probe descriptions are always consistent.
#
# Usage:
#   agent-rollcall-probe.sh --agent-id <uuid> --agent-name <name> --parent <issue-id>
#
# Output: prints the probe identifier (e.g. LINAA-42) on the first line of stdout,
#         followed by the full API response JSON (same as agent-create-issue.sh).
# Exits 0 on success, 1 on error.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Resolve agent-delegate scripts relative to this skill's location
DELEGATE_DIR="$(cd "$SCRIPT_DIR/../../agent-delegate/scripts" && pwd)"

AGENT_ID=""
AGENT_NAME=""
PARENT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent-id)   AGENT_ID="$2";   shift 2 ;;
    --agent-name) AGENT_NAME="$2"; shift 2 ;;
    --parent)     PARENT="$2";     shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$AGENT_ID" || -z "$AGENT_NAME" || -z "$PARENT" ]]; then
  echo "ERROR: --agent-id, --agent-name, and --parent are all required" >&2
  exit 1
fi

TITLE="Rollcall Probe - $AGENT_NAME"

DESCRIPTION="Perform a recursive rollcall of your **direct reports** using the **\`agent-rollcall\`** skill. 

This is a fresh-start diagnostic: **disregard all previous rollcall history, past comments, and old probe results.** Follow the protocol in your skill's \`SKILL.md\` strictly. If you have no direct reports, set this issue to \`done\` immediately to confirm you are operational."

exec "$DELEGATE_DIR/agent-create-issue.sh" \
  --title "$TITLE" \
  --assignee "$AGENT_ID" \
  --parent "$PARENT" \
  --status "todo" \
  --origin-kind "rollcall_probe" \
  --description "$DESCRIPTION"
