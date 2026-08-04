#!/usr/bin/env bash
# Deploy der Signaturbausteine nach ~/.paperclip/scripts/signatur/.
# macOS launchd kann CloudStorage/SynologyDrive nicht lesen -> Live-Kopie unter ~/.paperclip.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$REPO_ROOT/tools/signatur"
DEST="$HOME/.paperclip/scripts/signatur"

mkdir -p "$DEST/logos"

cp "$SRC"/signatur.py "$DEST/" 2>/dev/null || true
cp "$SRC"/signatur_build.py "$SRC"/logos_bauen.py "$DEST/"
cp "$SRC"/relay_signatur.js "$DEST/" 2>/dev/null || true
cp "$SRC"/patch_relay.py "$DEST/" 2>/dev/null || true
cp "$SRC"/bereiche.json "$SRC"/vorlage.html "$DEST/"
cp "$SRC"/logos/*.png "$DEST/logos/"

# Bausteine am Zielort erzeugen statt kopieren: sie sind abgeleitet und gross.
( cd "$DEST" && /usr/bin/python3 signatur_build.py )

echo "Deployt nach $DEST"
