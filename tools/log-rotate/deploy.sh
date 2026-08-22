#!/usr/bin/env bash
# Deploy der Log-Rotation nach ~/.paperclip/scripts/log-rotate/.
# macOS launchd kann CloudStorage/SynologyDrive nicht lesen -> Live-Kopie unter ~/.paperclip.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$REPO_ROOT/tools/log-rotate"
DEST="$HOME/.paperclip/scripts/log-rotate"
PLIST="ing.paperclip.log-rotate.plist"

mkdir -p "$DEST"
for f in "$SRC"/*.py; do
  cp "$f" "$DEST/$(basename "$f")"
done

cp "$SRC/$PLIST" "$HOME/Library/LaunchAgents/$PLIST"
launchctl bootout "gui/$(id -u)/ing.paperclip.log-rotate" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$PLIST"

echo "Deployt nach $DEST, Dienst neu geladen:"
launchctl list | grep log-rotate
