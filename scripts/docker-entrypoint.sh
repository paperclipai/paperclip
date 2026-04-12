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

# Fix ownership of mounted workspace directories so the node user can always
# write even if root previously created files (e.g. via docker exec or a
# misconfigured run). Only touches misowned files; idempotent and safe to run
# on every startup.
for _ws_dir in /workspace /mnt; do
    if [ -d "$_ws_dir" ]; then
        find "$_ws_dir" -maxdepth 5 -not -user node -not -type l \
            -exec chown node:node {} + 2>/dev/null || true
    fi
done

exec gosu node "$@"
