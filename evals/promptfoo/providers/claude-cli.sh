#!/bin/bash
# Promptfoo exec provider using Claude Code CLI.
# Promptfoo passes the rendered prompt via the PROMPT env var.
unset CLAUDECODE
echo "$PROMPT" | claude --print --model sonnet 2>/dev/null
