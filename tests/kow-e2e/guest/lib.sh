#!/bin/bash

wait_for() {
  local timeout="$1"; shift
  local i
  for ((i = 0; i < timeout; i++)); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

port_listening() { sudo ss -tnlp 2>/dev/null | grep -q "127.0.0.1:$1"; }

file_exists_sudo() { sudo test -f "$1"; }
