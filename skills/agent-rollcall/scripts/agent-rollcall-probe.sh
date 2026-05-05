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

DESCRIPTION="This is a rollcall probe. Your only job is to confirm you are operational.

If you have direct reports, run your own rollcall recursively and include a summary comment on this issue.

Once done, set this issue to \`done\`.

Do not write files to disk. Do not simulate. Use the API."

exec "$DELEGATE_DIR/agent-create-issue.sh" \
  --title "$TITLE" \
  --assignee "$AGENT_ID" \
  --parent "$PARENT" \
  --origin-kind "rolecall_probe" \
  --description "$DESCRIPTION"
