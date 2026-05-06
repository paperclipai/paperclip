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

# Railway (and some other runtimes) mount volumes as root after the image
# layers are applied, so /paperclip may be root-owned even when no UID remap
# occurred.  Chown just the top-level directory so the node process can create
# its own subdirectories.  Not recursive — avoids slowdown on large volumes.
if [ "$(stat -c '%u' /paperclip)" != "$PUID" ]; then
    chown node:node /paperclip
fi

exec gosu node "$@"
