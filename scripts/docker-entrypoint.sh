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

# Prepare the local Hermes runtime home. Paperclip launches Hermes as a plain
# command (`hermes`), so the official Hermes Docker entrypoint does not run in
# this image. Keep the state under /paperclip so it survives through the normal
# Paperclip volume.
HERMES_HOME=${HERMES_HOME:-/paperclip/hermes}
export HERMES_HOME

mkdir -p "$HERMES_HOME" \
    "$HERMES_HOME/cron" \
    "$HERMES_HOME/sessions" \
    "$HERMES_HOME/logs" \
    "$HERMES_HOME/hooks" \
    "$HERMES_HOME/memories" \
    "$HERMES_HOME/skills" \
    "$HERMES_HOME/skins" \
    "$HERMES_HOME/plans" \
    "$HERMES_HOME/workspace" \
    "$HERMES_HOME/home"

if [ -f /opt/hermes/.env.example ] && [ ! -f "$HERMES_HOME/.env" ]; then
    cp /opt/hermes/.env.example "$HERMES_HOME/.env"
fi

if [ -f /opt/hermes/cli-config.yaml.example ] && [ ! -f "$HERMES_HOME/config.yaml" ]; then
    cp /opt/hermes/cli-config.yaml.example "$HERMES_HOME/config.yaml"
fi

if [ -f /opt/hermes/docker/SOUL.md ] && [ ! -f "$HERMES_HOME/SOUL.md" ]; then
    cp /opt/hermes/docker/SOUL.md "$HERMES_HOME/SOUL.md"
fi

if [ -f /opt/hermes/scripts/skills_sync.py ]; then
    /opt/hermes/.venv/bin/python /opt/hermes/scripts/skills_sync.py >/dev/null 2>&1 || true
fi

# Keep Hermes provider dependencies resilient across upstream image changes.
# Hermes images are built with uv and may omit pip inside .venv; repair using
# uv when anthropic is missing.
if [ -x /opt/hermes/.venv/bin/python ]; then
    if ! /opt/hermes/.venv/bin/python -c "import anthropic" >/dev/null 2>&1; then
        echo "Installing missing Hermes dependency: anthropic>=0.39.0"
        if ! command -v uv >/dev/null 2>&1; then
            echo "ERROR: uv is required to repair Hermes Python dependencies" >&2
            exit 1
        fi
        uv pip install --python /opt/hermes/.venv/bin/python --no-cache-dir "anthropic>=0.39.0"
    fi
fi

chown -R node:node "$HERMES_HOME"

exec gosu node "$@"
