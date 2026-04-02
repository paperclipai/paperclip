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

# In authenticated deployments, the server hard-requires BETTER_AUTH_SECRET (or PAPERCLIP_AGENT_JWT_SECRET).
# To avoid CrashLoopBackOff / restart loops when operators forget to set it, generate and persist a secret
# in the mounted PAPERCLIP_HOME volume.
if [ "${PAPERCLIP_DEPLOYMENT_MODE:-}" = "authenticated" ] && \
   [ -z "${BETTER_AUTH_SECRET:-}" ] && \
   [ -z "${PAPERCLIP_AGENT_JWT_SECRET:-}" ]; then
    HOME_DIR=${PAPERCLIP_HOME:-/paperclip}
    SECRET_DIR="$HOME_DIR/secrets"
    SECRET_FILE="$SECRET_DIR/better-auth-secret"

    mkdir -p "$SECRET_DIR"

    if [ -f "$SECRET_FILE" ] && [ -s "$SECRET_FILE" ]; then
        BETTER_AUTH_SECRET=$(cat "$SECRET_FILE")
        export BETTER_AUTH_SECRET
        echo "Loaded BETTER_AUTH_SECRET from $SECRET_FILE"
    else
        BETTER_AUTH_SECRET=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')
        printf "%s" "$BETTER_AUTH_SECRET" > "$SECRET_FILE"
        chmod 600 "$SECRET_FILE" || true
        chown node:node "$SECRET_FILE" || true
        export BETTER_AUTH_SECRET
        echo "Generated BETTER_AUTH_SECRET and wrote to $SECRET_FILE"
    fi
fi

exec gosu node "$@"
