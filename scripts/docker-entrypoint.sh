#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Ensure /paperclip and its expected subdirectory structure exist with correct
# permissions BEFORE remapping UID/GID. On a fresh volume mount the directories
# won't exist yet, and the node process would fail to create them after the
# ownership change if root still owns the mount point.
mkdir -p -m 755 \
    /paperclip \
    /paperclip/instances/default/db \
    /paperclip/instances/default/logs \
    /paperclip/instances/default/secrets \
    /paperclip/instances/default/data/storage \
    /paperclip/instances/default/data/backups \
    /paperclip/instances/default/data/run-logs \
    /paperclip/instances/default/workspaces \
    /paperclip/instances/default/projects

# Transfer ownership of the entire tree to the node user so that all
# pre-created directories (and any files already on the volume) are writable
# after the UID/GID remap below.
chown -R node:node /paperclip

# Adjust the node user's UID/GID if they differ from the runtime request
if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
fi

exec gosu node "$@"
