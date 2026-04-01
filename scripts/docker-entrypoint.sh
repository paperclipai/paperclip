#!/bin/sh
set -eu

paperclip_home="${PAPERCLIP_HOME:-/paperclip}"
paperclip_bin_dir="${paperclip_home}/bin"
xdg_config_home="${XDG_CONFIG_HOME:-${paperclip_home}/.config}"
xdg_data_home="${XDG_DATA_HOME:-${paperclip_home}/.local/share}"
gemini_home="${paperclip_home}/.gemini"
opencode_install_dir="${PAPERCLIP_OPENCODE_INSTALL_DIR:-/opt/paperclip-opencode}"
opencode_bin="${opencode_install_dir}/node_modules/.bin/opencode"
gh_wrapper="/app/scripts/gh.sh"

mkdir -p "$paperclip_bin_dir" "$xdg_config_home" "$xdg_data_home" "$gemini_home"

if [ ! -x "$opencode_bin" ]; then
  echo "Missing OpenCode install at $opencode_bin" >&2
  exit 1
fi

if [ ! -x "$gh_wrapper" ]; then
  echo "Missing gh wrapper at $gh_wrapper" >&2
  exit 1
fi

ln -sf "$opencode_bin" "${paperclip_bin_dir}/opencode"
ln -sf "$gh_wrapper" "${paperclip_bin_dir}/gh"

exec "$@"
