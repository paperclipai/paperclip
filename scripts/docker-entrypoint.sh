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

# Ensure the persistent volume (mounted at /paperclip by the platform) is writable
# by the node user. Platforms like Railway mount volumes owned by root, and the
# UID/GID remap above is a no-op when node is already uid/gid 1000 — so the original
# `changed`-gated chown never ran and the app crashed with EACCES creating
# /paperclip/instances/default/logs. Chown whenever ownership is wrong (or remapped).
if [ "$changed" = "1" ] || [ "$(stat -c '%U' /paperclip 2>/dev/null)" != "node" ]; then
    echo "Fixing ownership of /paperclip for node user"
    chown -R node:node /paperclip || true
fi

exec gosu node "$@"
