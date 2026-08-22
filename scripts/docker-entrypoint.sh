#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Without root we can neither remap the node user (usermod/groupmod/chown)
# nor switch users (gosu needs CAP_SETUID/CAP_SETGID), so exec directly.
# This covers Kubernetes restricted PodSecurity (runAsNonRoot + runAsUser)
# as well as platforms that assign arbitrary UIDs (e.g. OpenShift); for the
# latter a UID/GID mismatch is unfixable here, so warn instead of letting
# usermod fail cryptically and keep volume-permission issues diagnosable.
if [ "$(id -u)" -ne 0 ]; then
    if [ "$(id -u)" -ne "$PUID" ] || [ "$(id -g)" -ne "$PGID" ]; then
        echo "docker-entrypoint.sh: running unprivileged as $(id -u):$(id -g); cannot remap to requested ${PUID}:${PGID}" >&2
    fi
    exec "$@"
fi

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

# Ensure the app home is owned by the runtime user BEFORE dropping
# privileges -- not only after a UID/GID remap. A freshly mounted volume
# (Docker named volume, Railway volume, Kubernetes PV) arrives root-owned
# and shadows the image's build-time chown, so with the default UID the old
# remap-only condition dropped privileges onto an unwritable home and the
# server crashed on its first mkdir. The probe is a first-mismatch find
# over the WHOLE tree (uid and gid): a root-owned mount or descendant
# (init containers, backup restores, files written before a remap) is
# found immediately and repaired recursively, a GID-only remap is caught,
# and a fully-correct tree costs one metadata-only walk with no chown.
home_dir="${PAPERCLIP_HOME:-/paperclip}"
if [ -d "$home_dir" ] && [ -n "$(find "$home_dir" \( ! -user node -o ! -group node \) -print -quit 2>/dev/null)" ]; then
    chown -R node:node "$home_dir"
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
