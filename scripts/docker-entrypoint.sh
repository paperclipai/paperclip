#!/bin/sh
set -e

# Timestamped progress lines make the pre-start phase (container start to
# the first app log line) measurable from the container log alone.
log() {
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) docker-entrypoint.sh: $*"
}

log "starting"

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
    log "starting app as $(id -u):$(id -g)"
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
# server crashed on its first mkdir.
#
# A full-tree probe costs one stat per file. On a home with many agent
# worktrees and node_modules trees that is minutes of boot time, so the
# probe is tiered:
#  1. A shallow probe (the home and its first few levels) runs on every
#     boot. It catches a fresh root-owned mount and a UID/GID remap, because
#     both change the owner of the home directory itself.
#  2. A full-tree probe runs only when the marker file below is missing or
#     records a different node UID/GID. It catches a mismatch deeper in the
#     tree (init containers, backup restores, files written before a remap,
#     the first boot after an upgrade from an older image).
# Any mismatch repairs the whole tree. After a clean probe or a repair, the
# marker records the verified node UID/GID, so later boots skip the full
# walk. Delete the marker to force a full probe on the next boot.
home_dir="${PAPERCLIP_HOME:-/paperclip}"
ownership_marker="$home_dir/.paperclip-ownership-verified"
ownership_shallow_depth=3

# Sets needs_repair=1 when any entry is not node:node, and probe_failed=1
# when find exits non-zero (for example, an I/O error), so an incomplete
# walk is never recorded as verified. The arguments bound the walk (empty
# for the full tree); -quit stops at the first mismatch.
probe_ownership() {
    if ! first_mismatch="$(find "$home_dir" "$@" \( ! -user node -o ! -group node \) -print -quit 2>/dev/null)"; then
        probe_failed=1
        log "ownership probe of $home_dir failed; it will run again on the next boot"
    fi
    if [ -n "$first_mismatch" ]; then
        needs_repair=1
    fi
}

if [ -d "$home_dir" ]; then
    expected_marker="v1 $(id -u node):$(id -g node)"
    current_marker="$(cat "$ownership_marker" 2>/dev/null || true)"
    needs_repair=0
    probe_failed=0
    probe_ownership -maxdepth "$ownership_shallow_depth"
    if [ "$needs_repair" -eq 0 ] && [ "$current_marker" != "$expected_marker" ]; then
        log "full ownership probe of $home_dir (no current marker)"
        probe_started=$(date +%s)
        probe_ownership
        log "full ownership probe finished in $(( $(date +%s) - probe_started ))s"
    fi

    if [ "$needs_repair" -eq 1 ]; then
        log "repairing ownership of $home_dir to node:node"
        repair_started=$(date +%s)
        chown -R node:node "$home_dir"
        log "ownership repair finished in $(( $(date +%s) - repair_started ))s"
    fi

    # Record the marker only when the tree is known good: a successful
    # recursive chown (set -e stops the script if it fails), or probes that
    # all completed without a mismatch.
    if [ "$current_marker" != "$expected_marker" ] && { [ "$needs_repair" -eq 1 ] || [ "$probe_failed" -eq 0 ]; }; then
        # Write as node so the marker itself never trips the shallow probe
        # (root-squashed network mounts included). Best effort: a read-only
        # home only costs a full probe on the next boot.
        # shellcheck disable=SC2016 # $1/$2 expand in the inner shell
        gosu node sh -c 'printf "%s\n" "$1" > "$2"' sh "$expected_marker" "$ownership_marker" 2>/dev/null || true
    fi
fi

log "starting app as node"
exec gosu node "$@"
