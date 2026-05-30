#!/bin/bash
# Scans file content for accidental credentials before writing.
# PreToolUse hook for Edit|Write operations.
# Exit 2 = block with "ask" decision so user can override. Exit 0 = allow.

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

if [ "$TOOL_NAME" = "Write" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
elif [ "$TOOL_NAME" = "Edit" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
else
  exit 0
fi

if [ -z "$CONTENT" ]; then
  exit 0
fi

MATCHES=""

# AWS access key IDs (literal 20-char key starting with AKIA)
if echo "$CONTENT" | grep -qP 'AKIA[0-9A-Z]{16}(?![0-9A-Z\[])'; then
  MATCHES="$MATCHES AWS access key;"
fi

# GitHub personal access tokens
if echo "$CONTENT" | grep -qE '(ghp_|gho_|ghs_|ghr_|github_pat_)[a-zA-Z0-9_]{20,}'; then
  MATCHES="$MATCHES GitHub token;"
fi

# Slack tokens
if echo "$CONTENT" | grep -qE 'xox[bpras]-[0-9a-zA-Z-]{10,}'; then
  MATCHES="$MATCHES Slack token;"
fi

# Private key PEM blocks
if echo "$CONTENT" | grep -qE -- '-----BEGIN[[:space:]]+(RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----'; then
  MATCHES="$MATCHES private key block;"
fi

# Connection strings with embedded credentials
if echo "$CONTENT" | grep -qE '(mongodb|postgres|mysql|redis|amqp|smtp)(\+[a-z]+)?://[^:[:space:]]+:[^@[:space:]]+@'; then
  MATCHES="$MATCHES connection string with credentials;"
fi

if [ -n "$MATCHES" ]; then
  REASON="Possible credential detected:$MATCHES Review carefully before allowing."
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\",\"permissionDecisionReason\":\"$REASON\"}}"
  exit 2
fi

exit 0
