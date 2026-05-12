#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Adjust the node user's UID/GID if they differ from the runtime request
# and fix volume ownership only when a remap is needed
changed=0

if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
    changed=1
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
    changed=1
fi

if [ "$changed" = "1" ]; then
    chown -R node:node /paperclip
fi

# When deployed on Render, fall back to its system-provided external URL so
# Paperclip's better-auth + invite flow has a base URL even before the operator
# pastes PAPERCLIP_PUBLIC_URL into the dashboard. Harmless on other platforms
# (variable is unset there).
if [ -z "${PAPERCLIP_PUBLIC_URL:-}" ] && [ -n "${RENDER_EXTERNAL_URL:-}" ]; then
    export PAPERCLIP_PUBLIC_URL="$RENDER_EXTERNAL_URL"
    echo "PAPERCLIP_PUBLIC_URL fell back to RENDER_EXTERNAL_URL=$RENDER_EXTERNAL_URL"
fi

exec gosu node "$@"
