#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[hermes-gateway-smoke] $*"
}

hash_prefix() {
  local value="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    printf "%s" "$value" | sha256sum | awk '{print substr($1,1,12)}'
  elif command -v shasum >/dev/null 2>&1; then
    printf "%s" "$value" | shasum -a 256 | awk '{print substr($1,1,12)}'
  else
    printf "unavailable"
  fi
}

generate_key() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
}

export HOME="${HOME:-/home/hermes}"
export HERMES_HOME="${HERMES_HOME:-${HOME}/.hermes}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-${HOME}/.config}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-${HOME}/.cache}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
export API_SERVER_ENABLED="${API_SERVER_ENABLED:-true}"
export API_SERVER_HOST="${API_SERVER_HOST:-0.0.0.0}"
export API_SERVER_PORT="${API_SERVER_PORT:-8642}"
export NO_COLOR="${NO_COLOR:-1}"

if [[ "${API_SERVER_ENABLED}" != "true" ]]; then
  log "forcing API_SERVER_ENABLED=true for gateway smoke"
  export API_SERVER_ENABLED=true
fi

if [[ -z "${API_SERVER_KEY:-}" ]]; then
  API_SERVER_KEY="$(generate_key)"
  export API_SERVER_KEY
  log "generated API_SERVER_KEY sha256=$(hash_prefix "$API_SERVER_KEY") len=${#API_SERVER_KEY}"
else
  log "using provided API_SERVER_KEY sha256=$(hash_prefix "$API_SERVER_KEY") len=${#API_SERVER_KEY}"
fi

mkdir -p "$HERMES_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$HOME/workspace"
chmod 0700 "$HERMES_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" || true

log "HOME=${HOME}"
log "HERMES_HOME=${HERMES_HOME}"
log "workspace=$(pwd)"
log "API_SERVER_HOST=${API_SERVER_HOST}"
log "API_SERVER_PORT=${API_SERVER_PORT}"
log "state listing hash=$(find "$HERMES_HOME" -maxdepth 2 -type f -print 2>/dev/null | sort | sha256sum | awk '{print substr($1,1,12)}')"

exec hermes gateway run --replace --accept-hooks "$@"
