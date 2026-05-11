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

# --- Ensure opencode state dirs are not scanned by rg and owned by runtime user ---
# Background: opencode CLI (invoked by paperclip runner) creates short-lived
# lock files under $HOME/.local/state/opencode/locks/. When the runner invokes
# rg from $HOME, recursive traversal races on these files and the tool-call
# fails with ENOENT (misrendered as "Permission denied"). See commit body.
PAPERCLIP_HOME="${PAPERCLIP_HOME:-/paperclip}"
if [ -d "$PAPERCLIP_HOME" ]; then
    if [ ! -f "$PAPERCLIP_HOME/.rgignore" ]; then
        cat > "$PAPERCLIP_HOME/.rgignore" <<RGIGNORE
.local/state/opencode/
.local/share/opencode/
.cache/opencode/
.config/opencode/
RGIGNORE
    fi
    # Normalize ownership so runtime user can always clean up its own locks.
    for d in .local/state/opencode .local/share/opencode .cache/opencode .config/opencode .rgignore; do
        [ -e "$PAPERCLIP_HOME/$d" ] && chown -R "$PUID:$PGID" "$PAPERCLIP_HOME/$d" 2>/dev/null || true
    done
fi
# --- end opencode rg race guard ---

exec gosu node "$@"
