#!/usr/bin/env bash
# Deploy der Signaturbausteine nach ~/.paperclip/scripts/signatur/.
# macOS launchd kann CloudStorage/SynologyDrive nicht lesen -> Live-Kopie unter ~/.paperclip.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$REPO_ROOT/tools/signatur"
DEST="$HOME/.paperclip/scripts/signatur"

mkdir -p "$DEST/logos"

# Pflichtdateien — fehlen sie, ist das ein Fehler und set -e soll greifen.
cp "$SRC"/signatur_build.py "$SRC"/logos_bauen.py "$DEST/"
cp "$SRC"/bereiche.json "$SRC"/vorlage.html "$DEST/"
cp "$SRC"/logos/*.png "$DEST/logos/"

# Optionale Dateien: entstehen erst in Aufgabe 3, 4 und 5. Fehlen ist in
# Ordnung, wird aber gemeldet — ein Deploy, das stillschweigend etwas
# auslaesst, ist genau der Drift, den dieses Skript verhindern soll.
for f in signatur.py relay_signatur.js patch_relay.py; do
  if [ -f "$SRC/$f" ]; then
    cp "$SRC/$f" "$DEST/"
  else
    echo "  uebersprungen (noch nicht vorhanden): $f"
  fi
done

# Bausteine am Zielort erzeugen statt kopieren: sie sind abgeleitet und gross.
( cd "$DEST" && /usr/bin/python3 signatur_build.py )

echo "Deployt nach $DEST"
