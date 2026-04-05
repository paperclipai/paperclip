#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEFAULT_E2E_HOME="$REPO_ROOT/.paperclip-local/e2e-home"

if [[ -n "${PNPM_BIN:-}" ]]; then
  :
elif command -v pnpm >/dev/null 2>&1; then
  PNPM_BIN="$(command -v pnpm)"
elif [[ -x "$HOME/.hermes/node/bin/pnpm" ]]; then
  PNPM_BIN="$HOME/.hermes/node/bin/pnpm"
else
  echo "Unable to find pnpm. Set PNPM_BIN or install pnpm." >&2
  exit 1
fi

export PATH="$(dirname "$PNPM_BIN"):$PATH"
export PAPERCLIP_HOME="${PAPERCLIP_E2E_HOME:-$DEFAULT_E2E_HOME}"
export PORT="${PAPERCLIP_E2E_PORT:-3100}"
export PAPERCLIP_DEPLOYMENT_MODE="${PAPERCLIP_DEPLOYMENT_MODE:-local_trusted}"
export HERMES_HOME="${PAPERCLIP_E2E_HERMES_HOME:-$PAPERCLIP_HOME/hermes}"
SOURCE_HERMES_HOME="${HERMES_SOURCE_HOME:-$HOME/.hermes}"

copy_optional_path() {
  local source_path="$1"
  local target_path="$2"
  if [[ -e "$source_path" ]]; then
    mkdir -p "$(dirname "$target_path")"
    cp -a "$source_path" "$target_path"
  fi
}

if [[ "${PAPERCLIP_E2E_RESET_HOME:-1}" == "1" ]]; then
  rm -rf "$PAPERCLIP_HOME"
fi
mkdir -p "$PAPERCLIP_HOME"
mkdir -p "$HERMES_HOME"

if [[ "$HERMES_HOME" != "$SOURCE_HERMES_HOME" ]]; then
  copy_optional_path "$SOURCE_HERMES_HOME/config.yaml" "$HERMES_HOME/config.yaml"
  copy_optional_path "$SOURCE_HERMES_HOME/.env" "$HERMES_HOME/.env"
  copy_optional_path "$SOURCE_HERMES_HOME/auth.json" "$HERMES_HOME/auth.json"
  copy_optional_path "$SOURCE_HERMES_HOME/oauth.json" "$HERMES_HOME/oauth.json"
  copy_optional_path "$SOURCE_HERMES_HOME/active_profile" "$HERMES_HOME/active_profile"
  if [[ -d "$SOURCE_HERMES_HOME/profiles" && ! -d "$HERMES_HOME/profiles" ]]; then
    cp -a "$SOURCE_HERMES_HOME/profiles" "$HERMES_HOME/profiles"
  fi
fi

cd "$REPO_ROOT"
"$PNPM_BIN" paperclipai onboard --yes
exec "$PNPM_BIN" paperclipai run
