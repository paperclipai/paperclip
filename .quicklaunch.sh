#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="$ROOT_DIR/.quicklaunch"
SERVER_LOG="$RUNTIME_DIR/server.log"
UI_LOG="$RUNTIME_DIR/ui.log"
PSG_LOG="$RUNTIME_DIR/psg-chatui.log"
SERVER_PID_FILE="$RUNTIME_DIR/server.pid"
UI_PID_FILE="$RUNTIME_DIR/ui.pid"
PSG_PID_FILE="$RUNTIME_DIR/psg-chatui.pid"
SERVER_PORT="${PAPERCLIP_SERVER_PORT:-3100}"
UI_PORT="${PAPERCLIP_UI_PORT:-5173}"
PSG_PORT="${PSG_CHATUI_PORT:-3000}"
UI_URL="http://localhost:${UI_PORT}"
CHAT_UI_PATH="${PAPERCLIP_CHAT_UI_PATH:-/tests/ux/chat}"
CHAT_UI_URL="http://localhost:${UI_PORT}${CHAT_UI_PATH}"
PSG_URL="http://localhost:${PSG_PORT}"
PSG_DIR="$ROOT_DIR/companies/psg-preller/chatui"
OPEN_CHAT_UI="${PAPERCLIP_QUICKLAUNCH_OPEN_CHAT_UI:-0}"
START_PSG_CHATUI="${PAPERCLIP_QUICKLAUNCH_START_PSG_CHATUI:-1}"
OPEN_PSG_CHATUI="${PAPERCLIP_QUICKLAUNCH_OPEN_PSG_CHATUI:-1}"
PSG_SHOULD_WAIT=0

mkdir -p "$RUNTIME_DIR"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

is_pid_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1
}

read_pid() {
  local file="$1"
  if [[ -f "$file" ]]; then
    tr -d '[:space:]' < "$file"
  fi
}

is_port_listening() {
  local port="$1"
  lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

start_service() {
  local name="$1"
  local command="$2"
  local pid_file="$3"
  local log_file="$4"
  local cwd="${5:-$ROOT_DIR}"

  local existing_pid
  existing_pid="$(read_pid "$pid_file" || true)"
  if is_pid_running "$existing_pid"; then
    echo "$name already running with PID $existing_pid"
    return 0
  fi

  rm -f "$pid_file"

  echo "Starting $name..."
  (
    cd "$cwd"
    nohup bash -lc "$command" >>"$log_file" 2>&1 &
    echo $! >"$pid_file"
  )

  sleep 1

  local new_pid
  new_pid="$(read_pid "$pid_file" || true)"
  if ! is_pid_running "$new_pid"; then
    echo "Failed to start $name. Check $log_file" >&2
    exit 1
  fi

  echo "$name started with PID $new_pid"
}

wait_for_port() {
  local port="$1"
  local label="$2"
  local attempts="${3:-60}"

  for ((i = 1; i <= attempts; i += 1)); do
    if is_port_listening "$port"; then
      echo "$label is ready on port $port"
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for $label on port $port" >&2
  return 1
}

require_cmd pnpm
require_cmd lsof
require_cmd open

is_enabled() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

if is_port_listening "$SERVER_PORT"; then
  echo "Backend port $SERVER_PORT is already in use; skipping backend start."
else
  start_service "backend" "pnpm dev:server" "$SERVER_PID_FILE" "$SERVER_LOG"
fi

if is_port_listening "$UI_PORT"; then
  echo "UI port $UI_PORT is already in use; skipping UI start."
else
  start_service "ui" "pnpm dev:ui" "$UI_PID_FILE" "$UI_LOG"
fi

if is_enabled "$START_PSG_CHATUI"; then
  if [[ -d "$PSG_DIR" ]]; then
    if is_port_listening "$PSG_PORT"; then
      echo "PSG chat UI port $PSG_PORT is already in use; skipping PSG chat UI start."
    else
      start_service "psg-chatui" "NODE_OPTIONS='--max-old-space-size=2048' PORT=${PSG_PORT} pnpm dev" "$PSG_PID_FILE" "$PSG_LOG" "$PSG_DIR"
    fi
    PSG_SHOULD_WAIT=1
  else
    echo "PSG chat UI directory not found at $PSG_DIR; skipping."
  fi
else
  echo "PSG chat UI is opt-in; set PAPERCLIP_QUICKLAUNCH_START_PSG_CHATUI=1 to launch it."
fi

wait_for_port "$SERVER_PORT" "Backend" 90 || true
wait_for_port "$UI_PORT" "UI" 90
if [[ "$PSG_SHOULD_WAIT" == "1" ]]; then
  wait_for_port "$PSG_PORT" "PSG Chat UI" 90 || true
fi

echo "Opening $UI_URL"
open "$UI_URL"

if is_enabled "$OPEN_CHAT_UI"; then
  echo "Opening $CHAT_UI_URL"
  open "$CHAT_UI_URL"
else
  echo "Chat UX Lab is opt-in; set PAPERCLIP_QUICKLAUNCH_OPEN_CHAT_UI=1 to open $CHAT_UI_URL."
fi

if is_enabled "$OPEN_PSG_CHATUI" && is_port_listening "$PSG_PORT"; then
  echo "Opening $PSG_URL"
  open "$PSG_URL"
elif is_enabled "$OPEN_PSG_CHATUI"; then
  echo "PSG chat UI is not listening on port $PSG_PORT; skipping browser open."
else
  echo "PSG chat UI browser open is opt-in; set PAPERCLIP_QUICKLAUNCH_OPEN_PSG_CHATUI=1 to open $PSG_URL."
fi

cat <<EOF

Quick launch complete.

- Backend log: $SERVER_LOG
- UI log: $UI_LOG
- PSG chat UI log: $PSG_LOG
- Backend PID file: $SERVER_PID_FILE
- UI PID file: $UI_PID_FILE
- PSG chat UI PID file: $PSG_PID_FILE
- Chat UX Lab URL: $CHAT_UI_URL
- PSG Chat UI URL: $PSG_URL
EOF
