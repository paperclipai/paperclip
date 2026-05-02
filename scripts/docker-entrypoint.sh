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

# Koenig customization 2026-04-30: set default agent commit identity to a GitHub-recognized
# noreply email so Vercel's Commit Author Email Verification passes. Agents may still override
# with their own role-specific identity at commit time; this is just the safe default.
gosu node git config --global user.name "Koenig Engineering Bot" 2>/dev/null || true
gosu node git config --global user.email "246262476+Vardaan97@users.noreply.github.com" 2>/dev/null || true
gosu node git config --global init.defaultBranch main 2>/dev/null || true
gosu node git config --global --add safe.directory '*' 2>/dev/null || true

# Koenig customization 2026-05-02 (KOEA-355): ensure hermes-py wrapper exists at /usr/local/bin.
# The Dockerfile bakes this in, but running containers need this on restarts.
# Running as root here so we can write to /usr/local/bin — idempotent.
if [ ! -x /usr/local/bin/hermes-py ]; then
    printf '#!/bin/sh\nexec /opt/hermes-venv/bin/hermes "$@"\n' > /usr/local/bin/hermes-py
    chmod +x /usr/local/bin/hermes-py
    ln -sf /usr/local/bin/hermes-py /usr/local/bin/hermes-container 2>/dev/null || true
    echo "hermes-py wrapper created at /usr/local/bin/hermes-py"
fi

exec gosu node "$@"
