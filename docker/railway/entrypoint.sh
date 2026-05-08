#!/bin/sh
set -e

# Fix Railway volume ownership: Railway mounts volumes as root even when the
# image runs unprivileged, so /paperclip may be root-owned.  Paperclip (user
# node) needs write access to create instances/default/logs and the db file.
if [ "$(stat -c '%u' /paperclip 2>/dev/null)" != "1000" ]; then
    chown node:node /paperclip
fi

# Write Claude OAuth credentials from env var so Claude Code can authenticate
# without needing a shell or interactive login.  Set CLAUDE_CREDENTIALS_JSON in
# Railway to the contents of ~/.claude/.credentials.json from a logged-in machine.
if [ -n "$CLAUDE_CREDENTIALS_JSON" ]; then
    mkdir -p /paperclip/.claude
    printf '%s' "$CLAUDE_CREDENTIALS_JSON" > /paperclip/.claude/.credentials.json
    chmod 600 /paperclip/.claude/.credentials.json
    chown node:node /paperclip/.claude /paperclip/.claude/.credentials.json
fi

# CADDY_PORT = the port Railway exposes (Railway injects $PORT at runtime).
# PAPERCLIP_PORT = the internal loopback port supervisord passes to Paperclip.
export CADDY_PORT="${PORT:-8080}"
export PAPERCLIP_PORT="3000"

exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
