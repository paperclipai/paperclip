#!/bin/bash
# paperclip-node.sh — repo-scoped Node 24 launcher for TSMC/Paperclip workspace
# Pins Node >=24.11.0 without touching Hermes ~/.local/bin/node or global PATH.
# Usage: ./scripts/paperclip-node.sh <command> [args...]
# Or source it: source scripts/paperclip-node.sh && node ...

set -euo pipefail

NODE24_DIR="$HOME/.nvm/versions/node/v24.19.0/bin"

if [ -d "$NODE24_DIR" ]; then
  export PATH="$NODE24_DIR:$PATH"
fi

# Assert version
node_version="$(node --version 2>/dev/null || echo 'none')"
if [[ "$node_version" != v24* ]]; then
  echo "ERROR: Expected Node >=24.11.0 but resolved '$node_version'." >&2
  echo "Ensure nvm install 24 && nvm use 24 in a fresh shell, or use the full prefix." >&2
  exit 1
fi

# If no args, just set env and print version (for sourcing)
if [ $# -eq 0 ]; then
  echo "Node 24 active: $node_version"
  echo "PATH prefix applied for this shell/process."
  exit 0
fi

# Otherwise exec the command under the pinned env
exec "$@"
