#!/usr/bin/env bash
set -euo pipefail

umask 077
ulimit -c 0
ulimit -n 128
ulimit -f 2048

: "${SCENARIO_CHAT_PUBLIC_ORIGIN:?SCENARIO_CHAT_PUBLIC_ORIGIN is required}"
: "${SCENARIO_CHAT_COMMIT_SHA:?SCENARIO_CHAT_COMMIT_SHA is required}"
: "${SCENARIO_CHAT_PROXY_PORT:?SCENARIO_CHAT_PROXY_PORT is required}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package_root="$(cd "$script_dir/.." && pwd)"
workspace_root="$(cd "$package_root/../.." && pwd)"
socket_dir="${SCENARIO_CHAT_SOCKET_DIR:-/tmp/paperclip-scenario-chat-pap-16917}"
socket_path="$socket_dir/scenario-chat.sock"

install -d -m 700 "$socket_dir"
rm -f "$socket_path"

server_pid=""
proxy_pid=""
cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$proxy_pid" ]]; then kill -TERM "$proxy_pid" 2>/dev/null || true; fi
  if [[ -n "$server_pid" ]]; then kill -TERM "$server_pid" 2>/dev/null || true; fi
  if [[ -n "$proxy_pid" ]]; then wait "$proxy_pid" 2>/dev/null || true; fi
  if [[ -n "$server_pid" ]]; then wait "$server_pid" 2>/dev/null || true; fi
  rm -f "$socket_path"
}
trap cleanup EXIT INT TERM

unshare -Un \
  --map-user=65534 \
  --map-group=65534 \
  --kill-child=SIGTERM \
  --fork \
  env -i \
    PATH=/usr/local/bin:/usr/bin:/bin \
    NODE_ENV=production \
    SCENARIO_CHAT_PUBLIC_ORIGIN="$SCENARIO_CHAT_PUBLIC_ORIGIN" \
    SCENARIO_CHAT_BASE_PATH="${SCENARIO_CHAT_BASE_PATH:-}" \
    SCENARIO_CHAT_COMMIT_SHA="$SCENARIO_CHAT_COMMIT_SHA" \
    SCENARIO_CHAT_ALLOW_INSECURE_HTTP="${SCENARIO_CHAT_ALLOW_INSECURE_HTTP:-}" \
    SCENARIO_CHAT_SOCKET_PATH="$socket_path" \
  node \
    --max-old-space-size=256 \
    --permission \
    --allow-fs-read="$package_root/dist" \
    --allow-fs-read="$package_root/dist-scenarios" \
    --allow-fs-read="$package_root/node_modules" \
    --allow-fs-read="$package_root/package.json" \
    --allow-fs-read="$package_root/spec/capability/eval-traceability.yaml" \
    --allow-fs-read="$workspace_root/node_modules" \
    --allow-fs-write="$socket_dir" \
    "$package_root/dist/live/scenario-chat-demo-server.js" &
server_pid=$!

for _ in $(seq 1 200); do
  if [[ -S "$socket_path" ]]; then break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then wait "$server_pid"; fi
  sleep 0.05
done
if [[ ! -S "$socket_path" ]]; then
  echo '{"event":"startup_failed","code":"socket_not_ready"}' >&2
  exit 1
fi

env -i \
  PATH=/usr/local/bin:/usr/bin:/bin \
  NODE_ENV=production \
  SCENARIO_CHAT_PUBLIC_ORIGIN="$SCENARIO_CHAT_PUBLIC_ORIGIN" \
  SCENARIO_CHAT_PROXY_PORT="$SCENARIO_CHAT_PROXY_PORT" \
  SCENARIO_CHAT_PROXY_HOST="${SCENARIO_CHAT_PROXY_HOST:-127.0.0.1}" \
  SCENARIO_CHAT_ALLOW_INSECURE_HTTP="${SCENARIO_CHAT_ALLOW_INSECURE_HTTP:-}" \
  SCENARIO_CHAT_SOCKET_PATH="$socket_path" \
node \
  --max-old-space-size=64 \
  --permission \
  --allow-fs-read="$package_root/dist/live/scenario-chat-loopback-proxy.js" \
  --allow-fs-read="$package_root/dist/live/scenario-chat-proxy-config.js" \
  --allow-fs-read="$socket_dir" \
  --allow-fs-write="$socket_dir" \
  "$package_root/dist/live/scenario-chat-loopback-proxy.js" &
proxy_pid=$!

wait -n "$server_pid" "$proxy_pid"
