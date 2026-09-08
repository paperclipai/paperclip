#!/bin/bash
# Run Paperclip from source (fork branch with transcript fragmentation fix).
# Branch: fix/hermes-gateway-delta-log-fragmentation (PR #9909)
#
# Usage:
#   ./run-paperclip.sh          # start in foreground
#   ./run-paperclip.sh --bg     # start in background (for systemd/screen)
#
# To update to latest upstream main + patch:
#   cd /root/paperclip-src && git fetch upstream && git merge upstream/master && pnpm install && pnpm build

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CWD="/root/metricgator/metricgator-argocd"

# Load Paperclip env
if [ -f "$HOME/.paperclip/instances/default/.env" ]; then
  set -a
  source "$HOME/.paperclip/instances/default/.env"
  set +a
fi

cd "$CWD"

if [ "${1:-}" = "--bg" ]; then
  nohup /root/.nvm/versions/node/v24.15.0/bin/node "$SCRIPT_DIR/cli/node_modules/tsx/dist/cli.mjs" \
    "$SCRIPT_DIR/cli/src/index.ts" run \
    > "$SCRIPT_DIR/paperclip.log" 2>&1 &
  echo "Paperclip started in background (PID: $!). Log: $SCRIPT_DIR/paperclip.log"
else
  exec /root/.nvm/versions/node/v24.15.0/bin/node "$SCRIPT_DIR/cli/node_modules/tsx/dist/cli.mjs" \
    "$SCRIPT_DIR/cli/src/index.ts" run
fi