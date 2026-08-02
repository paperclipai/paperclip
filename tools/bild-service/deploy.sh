#!/usr/bin/env bash
# Deploy des Bild-Dienstes nach ~/.paperclip/scripts/bild-service/.
# macOS launchd kann CloudStorage/SynologyDrive nicht lesen -> Live-Kopie unter ~/.paperclip.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$REPO_ROOT/tools/bild-service"
DEST="$HOME/.paperclip/scripts/bild-service"

mkdir -p "$DEST/workflows"

for f in "$SRC"/*.py; do
  cp "$f" "$DEST/$(basename "$f")"
done

if compgen -G "$SRC/workflows/*.json" > /dev/null; then
  cp "$SRC"/workflows/*.json "$DEST/workflows/"
fi

# Tests aus der Live-Kopie ausschliessen waere Unsinn: sie sind winzig und
# machen den Live-Stand selbst pruefbar.
echo "Deployt nach $DEST"
ls -1 "$DEST"
