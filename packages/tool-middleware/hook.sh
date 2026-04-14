#!/usr/bin/env bash
# Paperclip tool-middleware hook runner
# Feeds Claude Code PreToolUse/PostToolUse events through the TypeScript middleware:
#  - Prunes tool output to 1500 bytes / 300 tokens before it enters context
#  - Stores full stdout/stderr in content-addressed artifact store (secret-redacted)
#  - Emits spans to Langfuse asynchronously (never blocks Claude)

export LANGFUSE_BASE_URL="${LANGFUSE_BASE_URL:-http://localhost:3000}"
export LANGFUSE_PUBLIC_KEY="${LANGFUSE_PUBLIC_KEY:-pk-lf-0053bad8-1ca0-415e-822a-fd4d6d5dda0f}"
export LANGFUSE_SECRET_KEY="${LANGFUSE_SECRET_KEY:-sk-lf-4a34f875-9981-4a36-88b0-caf6643dd261}"

export TOOL_MIDDLEWARE_ARTIFACTS_DIR="${TOOL_MIDDLEWARE_ARTIFACTS_DIR:-${HOME}/.paperclip/tool-artifacts}"
export TOOL_MIDDLEWARE_CACHE_DIR="${TOOL_MIDDLEWARE_CACHE_DIR:-${HOME}/.paperclip/tool-cache}"

HOOK_BIN="$(dirname "$0")/dist/bin.js"

exec node "$HOOK_BIN"
