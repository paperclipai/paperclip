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

# Always ensure /paperclip is owned by node:node.
# The volume mount may have been created during build-time by root (e.g. hermes setup
# creating ~/.hermes/) and subdirectories created by the server at boot (e.g. data/,
# logs/) inherit the wrong owner when no UID/GID remap is needed.
# Without this, Paperclip's run-log-store, hermes adapter, and other components
# fail with EACCES when the node process tries to write to these directories.
chown -R node:node /paperclip

exec gosu node "$@"
