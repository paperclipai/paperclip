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

# Ensure ~/.local/bin/claude exists for the chat plugin which hard-codes
# `${HOME}/.local/bin/claude` (see @lucitra/paperclip-plugin-chat). The
# image bakes this symlink, but /paperclip is a PVC mount in k8s, so
# anything under /paperclip in the image layer is hidden at runtime.
mkdir -p /paperclip/.local/bin
if [ ! -e /paperclip/.local/bin/claude ]; then
    ln -sf /usr/local/bin/claude /paperclip/.local/bin/claude
fi
chown -R node:node /paperclip/.local 2>/dev/null || true

exec gosu node "$@"
