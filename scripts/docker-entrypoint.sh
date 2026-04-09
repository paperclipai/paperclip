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
else
    # Always fix ownership of files that may have been written as root
    # (e.g. via `docker exec` without --user), without a full recursive chown.
    # This targets the instance directory where .env and config.json are written.
    for DIR in "/paperclip/instances" "/paperclip/.codex"; do
        if [ -d "$DIR" ]; then
            find "$DIR" ! -user node -exec chown node:node {} +
        fi
    done
fi

# Auto-onboard on first run if no config exists
PAPERCLIP_CONFIG_FILE="${PAPERCLIP_CONFIG:-/paperclip/instances/default/config.json}"
if [ ! -f "$PAPERCLIP_CONFIG_FILE" ]; then
    echo "No config found at $PAPERCLIP_CONFIG_FILE — running onboard with environment defaults..."
    gosu node sh -c 'cd /app && pnpm paperclipai onboard --yes'
fi

exec gosu node "$@"
