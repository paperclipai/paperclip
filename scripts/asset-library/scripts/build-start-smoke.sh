#!/usr/bin/env bash
# Acceptance smoke for GLA-1026: prove `next build` + `next start` chain
# returns HTTP 200 with zero manual steps. Run on an isolated port so it does
# not collide with the running pm2 instance on :7700.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

NODE_BIN_DIR="/opt/homebrew/opt/node@20/bin"
if [[ -d "$NODE_BIN_DIR" ]]; then
  export PATH="$NODE_BIN_DIR:$PATH"
fi
export NODE_ENV=production

PORT="${SMOKE_PORT:-17700}"

echo "[smoke] next build"
npm run build

echo "[smoke] next start -p $PORT"
node node_modules/.bin/next start -p "$PORT" >/tmp/asset-library-smoke.log 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/"; then
    echo "[smoke] HTTP 200 on :$PORT — ok"
    exit 0
  fi
  sleep 1
done

echo "[smoke] FAIL — server did not respond 200 within 30s" >&2
tail -50 /tmp/asset-library-smoke.log >&2 || true
exit 1
