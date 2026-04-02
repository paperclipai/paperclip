#!/usr/bin/env bash
set -euo pipefail

CLAUDE_COMMAND="${CLAUDE_COMMAND:-claude}"
RUFLO_MCP_SERVER_NAME="${RUFLO_MCP_SERVER_NAME:-ruflo}"
CLAUDE_CONFIG_HOME="${CLAUDE_CONFIG_HOME:-}"
RUN_HELLO_PROBE="${RUN_HELLO_PROBE:-1}"

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

auth_logged_in() {
  local output
  output="$("$CLAUDE_COMMAND" auth status 2>&1 || true)"
  printf '%s\n' "$output" | grep -q '"loggedIn":[[:space:]]*true'
}

echo "Validating Claude MCP registration..."
MCP_LIST_OUTPUT="$("$CLAUDE_COMMAND" mcp list 2>&1 || true)"
if ! contains_server "$MCP_LIST_OUTPUT" "$RUFLO_MCP_SERVER_NAME"; then
  echo "error: Ruflo MCP server \"$RUFLO_MCP_SERVER_NAME\" not found in Claude MCP list." >&2
  echo "$MCP_LIST_OUTPUT" >&2
  exit 1
fi

if [[ "$RUN_HELLO_PROBE" != "1" ]]; then
  echo "Ruflo MCP registration looks good. Skipping Claude hello probe."
  exit 0
fi

if ! auth_logged_in; then
  echo "error: Claude is not logged in for this worker environment yet." >&2
  echo "Run 'claude login' with the same CLAUDE_CONFIG_HOME before attempting a live probe." >&2
  exit 1
fi

echo "Running Claude hello probe..."
set +e
PROBE_OUTPUT="$("$CLAUDE_COMMAND" --print - --output-format stream-json --verbose "Respond with exactly: ruflo-paperclip-ok" 2>&1)"
PROBE_EXIT=$?
set -e

if [[ $PROBE_EXIT -ne 0 ]]; then
  echo "error: Claude hello probe failed." >&2
  echo "$PROBE_OUTPUT" >&2
  exit $PROBE_EXIT
fi

if ! printf '%s\n' "$PROBE_OUTPUT" | grep -q "ruflo-paperclip-ok"; then
  echo "error: Claude hello probe did not return the expected marker." >&2
  echo "$PROBE_OUTPUT" >&2
  exit 1
fi

echo "Ruflo Claude local smoke test passed."
