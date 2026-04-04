#!/bin/bash
# Promptfoo exec provider using Claude Code CLI.
# Promptfoo passes the rendered prompt via the PROMPT env var.
unset CLAUDECODE
CLAUDE="${CLAUDE_BIN:-claude}"
echo "$PROMPT" | "$CLAUDE" --print --model sonnet --permission-mode plan 2>/dev/null
