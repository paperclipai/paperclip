#!/bin/sh
set -eu

# Hermes runs as the Paperclip runtime user and uses its private persistent home.
# Keep all other inherited Paperclip/container settings unchanged.
export HOME="${PAPERCLIP_HERMES_HOME:-/hermes-default}"
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
export PATH="$HOME/.local/bin:$PATH"

exec "$@"
