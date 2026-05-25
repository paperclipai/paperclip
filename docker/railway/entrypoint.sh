#!/bin/sh
set -e

# Fix Railway volume ownership: Railway mounts volumes as root even when the
# image runs unprivileged, so /paperclip may be root-owned.  Paperclip (user
# node) needs write access to create instances/default/logs and the db file.
if [ "$(stat -c '%u' /paperclip 2>/dev/null)" != "1000" ]; then
    chown node:node /paperclip
fi

# Materialise Claude credentials into the filesystem.
#
# The Claude Code CLI authenticates by reading
# `~/.claude/.credentials.json` (the subscription-OAuth token that
# `claude login` writes). Railway can't run an interactive login, so
# we ship the credentials as a `CLAUDE_CREDENTIALS_JSON` env var and
# materialise them here. Without this bridge the CEO-agent probe
# reports "Claude CLI is installed, but login is required" even
# though the env is set.
#
# HOME=/paperclip in this image, so claude resolves `~` to /paperclip.
if [ -n "${CLAUDE_CREDENTIALS_JSON}" ]; then
    mkdir -p /paperclip/.claude
    printf '%s' "${CLAUDE_CREDENTIALS_JSON}" > /paperclip/.claude/.credentials.json
    chmod 600 /paperclip/.claude/.credentials.json
    chown -R node:node /paperclip/.claude
fi

# CADDY_PORT = the port Railway exposes (Railway injects $PORT at runtime).
# PAPERCLIP_PORT = the internal loopback port supervisord passes to Paperclip.
export CADDY_PORT="${PORT:-8080}"
export PAPERCLIP_PORT="3000"

exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
