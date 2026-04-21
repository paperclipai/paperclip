#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="$ROOT_DIR/.quicklaunch"
SERVER_PID_FILE="$RUNTIME_DIR/server.pid"
UI_PID_FILE="$RUNTIME_DIR/ui.pid"
PSG_PID_FILE="$RUNTIME_DIR/psg-chatui.pid"

read_pid() {
  local file="$1"
  if [[ -f "$file" ]]; then
    tr -d '[:space:]' < "$file"
  fi
}

is_pid_running() {
  local pid="${1:-}"
  [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1
}

stop_pid() {
  local name="$1"
  local pid_file="$2"
  local pid

  pid="$(read_pid "$pid_file" || true)"
  if ! is_pid_running "$pid"; then
    echo "$name is not running."
    rm -f "$pid_file"
    return 0
  fi

  echo "Stopping $name (PID $pid)..."
  pkill -P "$pid" >/dev/null 2>&1 || true
  kill "$pid" >/dev/null 2>&1 || true

  for _ in {1..20}; do
    if ! is_pid_running "$pid"; then
      rm -f "$pid_file"
      echo "$name stopped."
      return 0
    fi
    sleep 1
  done

  echo "$name did not exit in time; sending SIGKILL."
  pkill -9 -P "$pid" >/dev/null 2>&1 || true
  kill -9 "$pid" >/dev/null 2>&1 || true
  rm -f "$pid_file"
}

stop_pid "backend" "$SERVER_PID_FILE"
stop_pid "ui" "$UI_PID_FILE"
stop_pid "psg-chatui" "$PSG_PID_FILE"

echo "Quick stop complete."
