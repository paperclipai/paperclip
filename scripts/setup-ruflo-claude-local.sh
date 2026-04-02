#!/usr/bin/env bash
set -euo pipefail

CLAUDE_COMMAND="${CLAUDE_COMMAND:-claude}"
RUFLO_COMMAND="${RUFLO_COMMAND:-ruflo}"
RUFLO_MCP_SERVER_NAME="${RUFLO_MCP_SERVER_NAME:-ruflo}"
RUFLO_MCP_SCOPE="${RUFLO_MCP_SCOPE:-user}"
CLAUDE_CONFIG_HOME="${CLAUDE_CONFIG_HOME:-}"

if [[ -n "$CLAUDE_CONFIG_HOME" ]]; then
  export HOME="$CLAUDE_CONFIG_HOME"
  export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
fi

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "error: required command not found: $command_name" >&2
    exit 1
  fi
}

contains_server() {
  local haystack="$1"
  local needle="$2"
  printf '%s\n' "$haystack" | grep -Eq "(^|[[:space:]])${needle}([[:space:]]|$)"
}

require_command "$CLAUDE_COMMAND"
require_command "$RUFLO_COMMAND"

echo "Checking Claude MCP registrations..."
MCP_LIST_OUTPUT="$("$CLAUDE_COMMAND" mcp list 2>&1 || true)"

if contains_server "$MCP_LIST_OUTPUT" "$RUFLO_MCP_SERVER_NAME"; then
  echo "Ruflo MCP server \"$RUFLO_MCP_SERVER_NAME\" is already registered."
  exit 0
fi

echo "Adding Ruflo MCP server \"$RUFLO_MCP_SERVER_NAME\" with scope \"$RUFLO_MCP_SCOPE\"..."
"$CLAUDE_COMMAND" mcp add --scope "$RUFLO_MCP_SCOPE" "$RUFLO_MCP_SERVER_NAME" -- "$RUFLO_COMMAND" mcp start

MCP_LIST_OUTPUT="$("$CLAUDE_COMMAND" mcp list 2>&1 || true)"
if ! contains_server "$MCP_LIST_OUTPUT" "$RUFLO_MCP_SERVER_NAME"; then
  echo "error: Ruflo MCP server \"$RUFLO_MCP_SERVER_NAME\" was not detected after registration." >&2
  echo "$MCP_LIST_OUTPUT" >&2
  exit 1
fi

echo "Ruflo MCP server \"$RUFLO_MCP_SERVER_NAME\" is configured for Claude."
