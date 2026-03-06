#!/bin/bash
# Strip Claude Code session vars so Paperclip can spawn claude subprocesses
# Also harden startup so local_trusted does not crash on non-loopback HOST.

set -euo pipefail

HOST="${HOST:-127.0.0.1}"
export HOST

deployment_mode="${PAPERCLIP_DEPLOYMENT_MODE:-local_trusted}"
if [ "$deployment_mode" = "local_trusted" ]; then
  case "$HOST" in
    127.0.0.1|localhost|::1)
      ;;
    *)
      export PAPERCLIP_DEPLOYMENT_MODE="authenticated"
      export PAPERCLIP_DEPLOYMENT_EXPOSURE="${PAPERCLIP_DEPLOYMENT_EXPOSURE:-private}"
      echo "[paperclip/start] Non-loopback HOST=$HOST with local_trusted; switching to authenticated/private to prevent crash." >&2
      ;;
  esac
fi

tsx_import="./server/node_modules/tsx/dist/esm/index.mjs"
if [ ! -f "$tsx_import" ]; then
  tsx_import="tsx"
fi

exec env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT \
  PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH" \
  node --import "$tsx_import" server/src/index.ts
