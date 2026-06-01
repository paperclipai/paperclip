#!/bin/bash
# Blocks dangerous shell commands before execution.
# PreToolUse hook for Bash operations.
# Exit 2 = block the action. Exit 0 = allow.

if ! command -v jq >/dev/null 2>&1; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"jq is required for command protection hooks but is not installed."}}'
  exit 2
fi

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Strip commit message content before pattern checking.
# Without this, git commit -m "docs: describe how we block resets" would be falsely blocked.
COMMAND_TO_CHECK="$COMMAND"
if [[ "$COMMAND" =~ git[[:space:]]+commit ]]; then
  COMMAND_TO_CHECK=$(echo "$COMMAND" | sed -E "s/-m[[:space:]]+['\"][^'\"]*['\"]//g" | sed -E "s/-m[[:space:]]+[^[:space:]]+//g")
  COMMAND_TO_CHECK=$(echo "$COMMAND_TO_CHECK" | sed -E 's/\$\(cat <<[^)]*\)//g')
fi

deny() {
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"$1\"}}"
  exit 2
}

# ── Git push protections ──────────────────────────────────────────────────────

if echo "$COMMAND_TO_CHECK" | grep -qE '(^|[;&|()]+[[:space:]]*)git[[:space:]]+push'; then

  if echo "$COMMAND_TO_CHECK" | grep -qE 'git[[:space:]]+push.*(origin[[:space:]]+|:)(master|main)\b'; then
    deny "Blocked: cannot push directly to master/main. Use a feature branch and create a PR."
  fi

  if echo "$COMMAND_TO_CHECK" | grep -qE 'git[[:space:]]+push[[:space:]]*($|[;&|])'; then
    CURRENT_BRANCH=$(git branch --show-current 2>/dev/null)
    if [ "$CURRENT_BRANCH" = "master" ] || [ "$CURRENT_BRANCH" = "main" ]; then
      deny "Blocked: you are on $CURRENT_BRANCH. Use a feature branch and create a PR."
    fi
  fi

  if echo "$COMMAND_TO_CHECK" | grep -qE 'git[[:space:]]+push.*(-[a-zA-Z]*f|--force)([[:space:]]|$)' && ! echo "$COMMAND_TO_CHECK" | grep -q '\-\-force-with-lease'; then
    deny "Blocked: force push is not allowed. Use --force-with-lease if you need to overwrite remote."
  fi
fi

# ── Git commit protections ────────────────────────────────────────────────────

if echo "$COMMAND_TO_CHECK" | grep -qE 'git[[:space:]]+commit.*--no-verify'; then
  deny "Blocked: --no-verify bypasses pre-commit hooks. Fix the underlying hook failure instead."
fi

# ── Destructive git operations ────────────────────────────────────────────────

if echo "$COMMAND_TO_CHECK" | grep -qE 'git[[:space:]]+reset[[:space:]]+--hard'; then
  deny "Blocked: git reset --hard discards uncommitted changes permanently. Use git stash or git reset --soft instead."
fi

if echo "$COMMAND_TO_CHECK" | grep -qE 'git[[:space:]]+clean[[:space:]]+-[a-zA-Z]*f'; then
  deny "Blocked: git clean -f permanently deletes untracked files. Review with git clean -n first."
fi

if echo "$COMMAND_TO_CHECK" | grep -qE '(^|[;&|()]+[[:space:]]*)git[[:space:]]+(checkout|switch)[[:space:]]+(master|main)([[:space:]]|$)'; then
  deny "Blocked: never check out master/main locally. Use a feature branch or worktree."
fi

if echo "$COMMAND_TO_CHECK" | grep -qE '(^|[;&|()]+[[:space:]]*)git[[:space:]]+(checkout|switch)[[:space:]]+[^-]'; then
  CURRENT_DIR=$(pwd)
  if [[ ! "$CURRENT_DIR" =~ \.worktrees/ ]]; then
    BRANCH_ARG=$(echo "$COMMAND_TO_CHECK" | awk '{
      found=0
      for(i=1;i<=NF;i++) {
        if ($i=="checkout" || $i=="switch") { found=i; break }
      }
      if (found) {
        for(j=found+1;j<=NF;j++) {
          if (substr($j,1,1)!="-") { print $j; break }
        }
      }
    }')
    if [[ "$BRANCH_ARG" != "." ]] && \
       ! [[ "$BRANCH_ARG" =~ ^[0-9a-f]{7,40}$ ]] && \
       ! [[ "$BRANCH_ARG" =~ ^v[0-9]+\.[0-9]+ ]] && \
       ! [[ "$BRANCH_ARG" =~ ^/ ]]; then
      deny "Blocked: switching branches on the main working tree tramples HEAD for parallel sessions. Use a worktree: git worktree add .worktrees/<name> <branch>"
    fi
  fi
fi

if echo "$COMMAND_TO_CHECK" | grep -qE 'git[[:space:]]+reset[[:space:]]+(--mixed[[:space:]]+|--soft[[:space:]]+)?(origin/)?(master|main)([[:space:]]|$)'; then
  deny "Blocked: git reset onto a protected ref can lose unpushed commits. Use 'git fetch && git merge --ff-only' instead."
fi

# ── Destructive filesystem operations ─────────────────────────────────────────

if echo "$COMMAND_TO_CHECK" | grep -qE 'rm[[:space:]]+-[a-zA-Z]*r[a-zA-Z]*f[[:space:]]+(\/|~|\$HOME|\.\.\/)'; then
  deny "Blocked: recursive force-delete on root/home/parent paths. Specify a safe target directory."
fi

if echo "$COMMAND_TO_CHECK" | grep -qE 'rm[[:space:]]+-[a-zA-Z]*r.*[[:space:]]+(\/[[:space:]]|\/\*|\/$|~\/?\*?[[:space:]]|~\/?\*?$)'; then
  deny "Blocked: recursive delete targeting root or home directory."
fi

# ── Dangerous database operations ─────────────────────────────────────────────

if echo "$COMMAND_TO_CHECK" | grep -qiE 'DROP[[:space:]]+(TABLE|DATABASE|SCHEMA)[[:space:]]'; then
  deny "Blocked: DROP TABLE/DATABASE/SCHEMA is destructive and irreversible. Run manually if intended."
fi

if echo "$COMMAND_TO_CHECK" | grep -qiE 'DELETE[[:space:]]+FROM[[:space:]]+[a-zA-Z_]+[[:space:]]*($|;)' && ! echo "$COMMAND_TO_CHECK" | grep -qiE 'WHERE'; then
  deny "Blocked: DELETE FROM without WHERE clause would delete all rows. Add a WHERE clause."
fi

if echo "$COMMAND_TO_CHECK" | grep -qiE 'TRUNCATE[[:space:]]+TABLE'; then
  deny "Blocked: TRUNCATE TABLE is destructive and irreversible. Run manually if intended."
fi

# ── Dangerous system commands ─────────────────────────────────────────────────

if echo "$COMMAND_TO_CHECK" | grep -qE 'chmod[[:space:]]+777'; then
  deny "Blocked: chmod 777 gives everyone read/write/execute. Use more restrictive permissions."
fi

if echo "$COMMAND_TO_CHECK" | grep -qE '(curl|wget)[[:space:]].*\|[[:space:]]*(bash|sh|zsh|sudo)'; then
  deny "Blocked: piping downloaded content directly to a shell is dangerous. Download first, inspect, then execute."
fi

if echo "$COMMAND_TO_CHECK" | grep -qE '(mkfs|dd[[:space:]]+if=|>[[:space:]]*/dev/)' && ! echo "$COMMAND_TO_CHECK" | grep -qE '>[[:space:]]*/dev/(null|stderr|stdout|tty|fd/)'; then
  deny "Blocked: destructive disk operation detected."
fi

# ── Accidental package publishing ─────────────────────────────────────────────

if echo "$COMMAND_TO_CHECK" | grep -qE '(npm|yarn|pnpm|bun)[[:space:]]+publish'; then
  deny "Blocked: publishing npm packages should be done manually or via CI, not through Claude Code."
fi

exit 0
