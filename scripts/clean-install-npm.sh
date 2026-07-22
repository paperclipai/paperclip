#!/bin/bash
set -euo pipefail

PC_TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-clean-install.XXXXXX")"
PC_HOME="$PC_TEST_ROOT/home"
PC_CACHE="$PC_TEST_ROOT/npm-cache"
mkdir -p "$PC_HOME" "$PC_CACHE"
trap 'rm -rf "$PC_TEST_ROOT"' EXIT

export HOME="$PC_HOME"
export npm_config_cache="$PC_CACHE"
export npm_config_userconfig="$PC_HOME/.npmrc"
export PATH="$PC_HOME/.local/bin:$PATH"

cd "$PC_TEST_ROOT"
npx --yes --registry https://registry.npmjs.org paperclipai install

test -x "$PC_HOME/.local/bin/paperclipai"
test -L "$PC_HOME/.paperclip/cli/current"
test -f "$PC_HOME/.paperclip/cli/install.json"
paperclipai --version

mkdir -p "$PC_HOME/.paperclip/instances/default"
touch "$PC_HOME/.paperclip/instances/default/user-data-marker"
paperclipai uninstall

test ! -e "$PC_HOME/.paperclip/cli"
test ! -e "$PC_HOME/.local/bin/paperclipai"
test -f "$PC_HOME/.paperclip/instances/default/user-data-marker"
