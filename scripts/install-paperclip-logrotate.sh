#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_FILE="$REPO_ROOT/ops/logrotate/paperclip"
TARGET_FILE="/etc/logrotate.d/paperclip"

if [[ ! -f "$SOURCE_FILE" ]]; then
  echo "Missing source logrotate file: $SOURCE_FILE" >&2
  exit 1
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "This installer must run as root (sudo)." >&2
  exit 1
fi

install -m 0644 "$SOURCE_FILE" "$TARGET_FILE"

echo "Installed $TARGET_FILE"
echo "Running validation: logrotate -d $TARGET_FILE"
logrotate -d "$TARGET_FILE"

echo "Done."
