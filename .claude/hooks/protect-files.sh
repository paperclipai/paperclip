#!/bin/bash
# Blocks edits to sensitive or generated files.
# PreToolUse hook for Edit|Write operations.
# Exit 2 = block the action. Exit 0 = allow.

if ! command -v jq >/dev/null 2>&1; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"jq is required for file protection hooks but is not installed."}}'
  exit 2
fi

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

deny() {
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"$1\"}}"
  exit 2
}

ask() {
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\",\"permissionDecisionReason\":\"$1\"}}"
  exit 2
}

BASENAME=$(basename "$FILE_PATH")

PROTECTED_PATTERNS=(
  "*.pem"
  "*.key"
  "*.crt"
  "*.p12"
  "*.pfx"
  "id_rsa"
  "id_ed25519"
  "credentials.json"
  "*.gen.ts"
  "*.generated.*"
  "*.min.js"
  "*.min.css"
)

for pattern in "${PROTECTED_PATTERNS[@]}"; do
  case "$BASENAME" in
    $pattern)
      deny "Protected file: $BASENAME matches '$pattern'. Cannot edit cryptographic keys, credentials, or generated files."
      ;;
  esac
done

case "$FILE_PATH" in
  .git/*|*/.git/*)
    deny "Cannot edit files inside .git/"
    ;;
  secrets/*|*/secrets/*)
    deny "Cannot edit files inside secrets/"
    ;;
  .env|.env.*|*/.env|*/.env.*)
    deny "Cannot edit .env files — use environment variables or config instead."
    ;;
  .claude/hooks/*|*/.claude/hooks/*)
    deny "Cannot edit hook scripts — these enforce security boundaries. Edit manually if needed."
    ;;
  .claude/settings.json|*/.claude/settings.json)
    ask "Editing settings.json — this controls permissions and hooks. Confirm this change."
    ;;
  .claude/settings.local.json|*/.claude/settings.local.json)
    ask "Editing settings.local.json — this controls local permissions. Confirm this change."
    ;;
esac

exit 0
