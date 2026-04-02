#!/bin/sh
set -e

# ── Claude config bootstrap ──────────────────────────────────────────
# Claude CLI needs a WRITABLE config directory for sessions, analytics,
# and settings.  The shared credentials volume from claude-code-docker
# is mounted read-only at /claude-config-shared.  We copy credentials
# into a writable directory so Claude can both read creds and write
# runtime data.
CLAUDE_WRITABLE="${CLAUDE_CONFIG_DIR:-/paperclip/.claude-config}"
mkdir -p "$CLAUDE_WRITABLE"
chown node:node "$CLAUDE_WRITABLE" 2>/dev/null || true

if [ -d /claude-config-shared ]; then
    for f in .credentials.json settings.json statsig.json; do
        if [ -f "/claude-config-shared/$f" ]; then
            cp -a "/claude-config-shared/$f" "$CLAUDE_WRITABLE/" 2>/dev/null || true
        fi
    done
    chown -R node:node "$CLAUDE_WRITABLE" 2>/dev/null || true
    echo "Claude config: copied credentials from shared volume to $CLAUDE_WRITABLE"
else
    echo "Claude config: no shared volume at /claude-config-shared (using API key or built-in claude)"
fi

# Delegate to the original upstream entrypoint
exec /usr/local/bin/docker-entrypoint.sh "$@"
