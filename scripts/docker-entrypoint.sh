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

# Managed embedded database stacks (Paperclip Cloud): the supervisor must start
# as root so PostgreSQL and the tenant app run as different OS users. Any
# problem with the contract fails closed here; the supervisor validates the rest.
managed_db_root=""
if [ -n "${PAPERCLIP_MANAGED_DATABASE+x}" ]; then
    if [ "$(id -u)" -ne 0 ]; then
        echo "docker-entrypoint.sh: PAPERCLIP_MANAGED_DATABASE requires starting as root" >&2
        exit 1
    fi
    managed_db_root="$(printf '%s' "$PAPERCLIP_MANAGED_DATABASE" | jq -er '.root')" || {
        echo "docker-entrypoint.sh: PAPERCLIP_MANAGED_DATABASE is not valid JSON with a root" >&2
        exit 1
    }
    managed_db_user="${PAPERCLIP_MANAGED_DATABASE_DB_USER:-paperclip-db}"
    # The supervisor runs as root, so it must come from the root-owned bundle
    # (the cloud image target), never from /app, which the app user owns.
    managed_db_supervisor=/opt/paperclip-managed-database
    if [ ! -f "$managed_db_supervisor/main.mjs" ] || [ ! -f "$managed_db_supervisor/release.json" ]; then
        echo "docker-entrypoint.sh: this image has no managed database supervisor; build the cloud target" >&2
        exit 1
    fi
    # Symbolic links (the engine's library aliases) always report mode 0777.
    if [ -n "$(find "$managed_db_supervisor" \( ! -user root -o \( ! -type l -perm /022 \) \) -print -quit)" ]; then
        echo "docker-entrypoint.sh: $managed_db_supervisor must be root-owned and unwritable by other users" >&2
        exit 1
    fi
fi

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

# Adjust the node user's UID/GID if they differ from the runtime request.
#
# `usermod -u` and `usermod -g` also re-own every file under the user's home
# directory. When that home is the app home (the data volume), the walk can
# take minutes on a large home, and the app cannot start until it ends. In
# that case the remap runs while the home points at a placeholder path that
# does not exist, so usermod changes only the account, and the ownership probe
# below repairs the app home when the IDs really changed (the home directory
# itself then has the old owner, which the shallow probe detects on the same
# boot). A passwd home outside the app home is not covered by that probe, so
# it keeps the plain usermod behavior, which re-owns it.
#
# The placeholder embeds the original home, so a boot that stops between the
# two usermod -d calls is repaired on the next start of the same container.
remap_home_prefix="/nonexistent/paperclip-uid-remap"
node_home="$(getent passwd node 2>/dev/null | cut -d: -f6 || true)"
case "$node_home" in
    "$remap_home_prefix"/*)
        node_home="${node_home#"$remap_home_prefix"}"
        echo "Restoring node home to $node_home after an interrupted remap"
        usermod -d "$node_home" node
        ;;
esac

remap_uid=0
remap_gid=0
[ "$(id -u node)" -ne "$PUID" ] && remap_uid=1
[ "$(id -g node)" -ne "$PGID" ] && remap_gid=1
app_home="${PAPERCLIP_HOME:-/paperclip}"
move_home=0
if { [ "$remap_uid" -eq 1 ] || [ "$remap_gid" -eq 1 ]; } \
    && [ -n "$node_home" ] && [ "${node_home%/}" = "${app_home%/}" ]; then
    move_home=1
    usermod -d "$remap_home_prefix$node_home" node
fi

if [ "$remap_uid" -eq 1 ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
fi

if [ "$remap_gid" -eq 1 ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
fi

if [ "$move_home" -eq 1 ]; then
    usermod -d "$node_home" node
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
if [ -n "$managed_db_root" ]; then
    # The supervisor's directory stays owned by root and the database user;
    # handing it to node would give the app the database files and secrets.
    # The tiered probe below repairs with an unpruned chown -R, so managed
    # stacks keep this pruned full walk and never record the marker.
    #
    # A volume written before its parents were protected (below) may hold the
    # supervisor's directory under another name, so the walk does not trust
    # its path alone. It also skips every directory that holds a root-owned
    # volume.json (the supervisor's identity file, which the app cannot
    # create) and everything the database user owns.
    if [ -d "$home_dir" ]; then
        find "$home_dir" \( -path "$managed_db_root" \
                -o \( -type d -user "$managed_db_user" \) \
                -o \( -type d -user root -exec test -f {}/volume.json \; -exec test -O {}/volume.json \; \) \
            \) -prune \
            -o ! -user "$managed_db_user" \( ! -user node -o ! -group node \) -exec chown -h node:node {} +
    fi
    # Rename permission comes from the parent directory, so the supervisor's
    # root-only modes protect nothing while the app can write a directory
    # above it. Every directory from its parent up to the volume mount becomes
    # root-owned and sticky: the app (group node) still creates and replaces
    # its own entries in its home, but cannot rename the supervisor's
    # directory. The supervisor refuses to start without this.
    managed_db_mount="$(printf '%s' "$PAPERCLIP_MANAGED_DATABASE" | jq -er '.volume.mountPath')" || {
        echo "docker-entrypoint.sh: PAPERCLIP_MANAGED_DATABASE has no volume.mountPath" >&2
        exit 1
    }
    # Only a normalized root strictly inside a mount other than / is walked,
    # so the loop never reaches a directory outside the volume.
    case "$managed_db_root" in
        [!/]*|*//*|*/./*|*/../*|*/.|*/..) managed_db_root_inside=0 ;;
        "$managed_db_mount"/?*) managed_db_root_inside=1 ;;
        *) managed_db_root_inside=0 ;;
    esac
    if [ -z "$managed_db_mount" ] || [ "$managed_db_mount" = / ] || [ "$managed_db_root_inside" -ne 1 ]; then
        echo "docker-entrypoint.sh: managed database root must be a normalized path inside a volume mount other than /" >&2
        exit 1
    fi
    dir="$(dirname "$managed_db_root")"
    while :; do
        if [ -L "$dir" ]; then
            echo "docker-entrypoint.sh: $dir is a symbolic link; refusing to protect the managed database root" >&2
            exit 1
        fi
        if [ -d "$dir" ]; then
            chown root:node "$dir"
            chmod 1775 "$dir"
        fi
        [ "$dir" != "$managed_db_mount" ] || break
        dir="$(dirname "$dir")"
    done
    log "starting managed database supervisor"
    exec node "$managed_db_supervisor/main.mjs" run -- "$@"
fi
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
