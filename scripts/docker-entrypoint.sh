#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Adjust the node user's UID/GID if they differ from the runtime request.
# (Volume ownership is fixed unconditionally below, regardless of any remap.)
if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
fi

# Ensure the persistent volume (mounted at /paperclip by the platform) is writable
# by the node user. Platforms like Railway mount volumes owned by root, and the
# UID/GID remap above is a no-op when node is already uid/gid 1000 — so the original
# `changed`-gated chown never ran and the app crashed with EACCES creating
# /paperclip/instances/default/logs.
#
# Always chown -R, unconditionally: gating on the /paperclip ROOT's ownership is
# not enough. Once the root is node-owned, the gate short-circuits — but
# subdirectories created at runtime by root-owned processes (e.g. the hermes_local
# adapter writing /paperclip/.hermes/.env) can still be root-owned, causing
# PermissionError. The volume is small, so an idempotent recursive chown on every
# boot is cheap and guarantees every path under /paperclip is writable by node.
echo "Fixing ownership of /paperclip (recursive) for node user"
chown -R node:node /paperclip || true

exec gosu node "$@"
