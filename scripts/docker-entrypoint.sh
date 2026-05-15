#!/bin/sh
set -e

# ---------------------------------------------------------------------------
# Tailscale sidecar — starts if TAILSCALE_AUTHKEY is set.
# ---------------------------------------------------------------------------
if [ -n "$TAILSCALE_AUTHKEY" ]; then
    echo "Starting Tailscale daemon..."
    tailscaled \
        --state=/var/lib/tailscale/tailscaled.state \
        --socket=/var/run/tailscale/tailscaled.sock \
        --tun=userspace-networking &

    # Wait for the daemon socket to appear
    for i in $(seq 1 30); do
        if [ -S /var/run/tailscale/tailscaled.sock ]; then break; fi
        sleep 0.5
    done

    TAILSCALE_ARGS="--authkey=${TAILSCALE_AUTHKEY} --ssh"
    if [ -n "$TAILSCALE_HOSTNAME" ]; then
        TAILSCALE_ARGS="${TAILSCALE_ARGS} --hostname=${TAILSCALE_HOSTNAME}"
    else
        TAILSCALE_ARGS="${TAILSCALE_ARGS} --hostname=paperclip-railway"
    fi

    tailscale --socket=/var/run/tailscale/tailscaled.sock up $TAILSCALE_ARGS
    echo "Tailscale is up: $(tailscale --socket=/var/run/tailscale/tailscaled.sock ip -4 2>/dev/null || echo 'connecting...')"
fi

# ---------------------------------------------------------------------------
# Non-root fast path (Railway, rootless containers)
# ---------------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
    exec "$@"
fi

# ---------------------------------------------------------------------------
# Root path — UID/GID remapping for docker-compose
# ---------------------------------------------------------------------------
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

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

exec gosu node "$@"
