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

# Always ensure the paperclip data root is owned by node so it can create
# subdirectories. This handles freshly mounted volumes or volumes where the
# root directory is owned by root (a common Docker volume initialisation quirk).
chown node:node /paperclip

# Pre-create the standard instance directory tree so the server never hits a
# permission error when it first tries to write run-logs or other data files.
INSTANCE_ID="${PAPERCLIP_INSTANCE_ID:-default}"
INSTANCE_DIR="/paperclip/instances/${INSTANCE_ID}"
mkdir -p \
    "${INSTANCE_DIR}/data/run-logs" \
    "${INSTANCE_DIR}/data/storage" \
    "${INSTANCE_DIR}/data/backups" \
    "${INSTANCE_DIR}/logs" \
    "${INSTANCE_DIR}/db" \
    "${INSTANCE_DIR}/secrets" \
    "${INSTANCE_DIR}/workspaces"
chown -R node:node "${INSTANCE_DIR}"

exec gosu node "$@"
