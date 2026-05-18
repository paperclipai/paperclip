#!/usr/bin/env bash
set -euo pipefail

errors=0

check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "MISSING: $1"
    errors=$((errors + 1))
  fi
}

check_cmd curl
check_cmd systemctl
check_cmd terraform
check_cmd cloudflared
check_cmd logrotate

if [ "$EUID" -ne 0 ]; then
  echo "ERROR: Must run as root."
  errors=$((errors + 1))
fi

if [ "$errors" -gt 0 ]; then
  echo "FAILED: $errors prerequisite check(s) failed."
  exit 1
fi

echo "All prerequisites satisfied."
