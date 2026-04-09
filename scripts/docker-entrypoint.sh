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

# Add node user to the Docker socket group so hermes-bridge.sh can
# `docker exec` into the hermes-agent sidecar after privilege drop.
DOCKER_SOCK_GID=$(stat -c '%g' /var/run/docker.sock 2>/dev/null || true)
if [ -n "$DOCKER_SOCK_GID" ] && [ "$DOCKER_SOCK_GID" != "0" ]; then
    if ! usermod -aG "$DOCKER_SOCK_GID" node 2>/dev/null; then
        echo "Warning: Failed to add node user to Docker socket group (GID $DOCKER_SOCK_GID). hermes-bridge.sh may not be able to exec into hermes-agent sidecar." >&2
    fi
fi

# --- Fork: tool wiring (OpenCode, gh wrapper) ---
paperclip_home="${PAPERCLIP_HOME:-/paperclip}"
paperclip_bin_dir="${paperclip_home}/bin"
xdg_config_home="${XDG_CONFIG_HOME:-${paperclip_home}/.config}"
xdg_data_home="${XDG_DATA_HOME:-${paperclip_home}/.local/share}"
gemini_home="${paperclip_home}/.gemini"
opencode_install_dir="${PAPERCLIP_OPENCODE_INSTALL_DIR:-/opt/paperclip-opencode}"
opencode_bin="${opencode_install_dir}/node_modules/.bin/opencode"
gh_wrapper="/app/scripts/gh.sh"

mkdir -p "$paperclip_bin_dir" "$xdg_config_home" "$xdg_data_home" "$gemini_home" 2>/dev/null || true

if [ -x "$opencode_bin" ]; then
  ln -sf "$opencode_bin" "${paperclip_bin_dir}/opencode" 2>/dev/null || true
fi

if [ -x "$gh_wrapper" ]; then
  ln -sf "$gh_wrapper" "${paperclip_bin_dir}/gh" 2>/dev/null || true
fi

# Google Workspace tools (gmail, ga4, gws-token)
gws_tools_dir="/app/tools/google-workspace"
if [ -d "$gws_tools_dir" ]; then
  for tool in "$gws_tools_dir"/*.js; do
    [ -f "$tool" ] && ln -sf "$tool" "${paperclip_bin_dir}/$(basename "$tool")" 2>/dev/null || true
  done
fi

# --- Verify bundled skill pack is complete before starting the server ---
if [ -x /usr/local/bin/verify-skills.sh ]; then
    echo "[docker-entrypoint] Verifying bundled skill pack..."
    /usr/local/bin/verify-skills.sh || echo "[docker-entrypoint] WARNING: skill verification failed — continuing anyway"
fi

exec gosu node "$@"