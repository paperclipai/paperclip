#!/bin/sh
set -eu

# --- Upstream: UID/GID remapping for bind-mount compatibility ---
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

# --- Fork: tool wiring (OpenCode, gh wrapper) ---
paperclip_home="${PAPERCLIP_HOME:-/paperclip}"
paperclip_bin_dir="${paperclip_home}/bin"
xdg_config_home="${XDG_CONFIG_HOME:-${paperclip_home}/.config}"
xdg_data_home="${XDG_DATA_HOME:-${paperclip_home}/.local/share}"
gemini_home="${paperclip_home}/.gemini"
opencode_install_dir="${PAPERCLIP_OPENCODE_INSTALL_DIR:-/opt/paperclip-opencode}"
opencode_bin="${opencode_install_dir}/node_modules/.bin/opencode"
gh_wrapper="/app/scripts/gh.sh"

mkdir -p "$paperclip_bin_dir" "$xdg_config_home" "$xdg_data_home" "$gemini_home"

if [ -x "$opencode_bin" ]; then
  ln -sf "$opencode_bin" "${paperclip_bin_dir}/opencode"
fi

if [ -x "$gh_wrapper" ]; then
  ln -sf "$gh_wrapper" "${paperclip_bin_dir}/gh"
fi

exec gosu node "$@"
