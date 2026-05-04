#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
fi

# Always chown the home volume — the node user must own its $HOME
# regardless of whether the UID/GID were remapped this run. Pre-existing
# root-owned files (from image build or an earlier root process writing
# into the volume) would otherwise stay uneditable to the runtime.
chown -R node:node /paperclip

exec gosu node "$@"
