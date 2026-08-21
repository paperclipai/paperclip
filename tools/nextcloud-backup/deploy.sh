#!/usr/bin/env bash
# Deploy der Auswaerts-Sicherung nach ~/.paperclip/scripts/nextcloud-backup/.
# macOS launchd kann CloudStorage/SynologyDrive nicht lesen -> Live-Kopie unter ~/.paperclip.
#
# Wie bei tools/llm-usage bewusst OHNE fest verdrahtete Dateiliste und MIT den
# Tests: beide Bauarten haben bei Websuche und Jarvis-Bot schon Drift erzeugt.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$REPO_ROOT/tools/nextcloud-backup"
DEST="$HOME/.paperclip/scripts/nextcloud-backup"
PLIST="de.whitestag.nextcloud-backup.plist"

mkdir -p "$DEST"

rsync -a --delete \
  --exclude '__pycache__/' \
  --exclude '.pytest_cache/' \
  --exclude 'deploy.sh' \
  --exclude 'README.md' \
  --exclude '*.plist' \
  "$SRC/" "$DEST/"

chmod +x "$DEST"/*.sh

# Gegenprobe: was hier durchrutscht, faellt sonst erst im Ernstfall auf.
ABWEICHUNG=$(diff -rq \
  --exclude '__pycache__' --exclude '.pytest_cache' \
  --exclude 'deploy.sh' --exclude 'README.md' --exclude '*.plist' \
  "$SRC" "$DEST" || true)
if [ -n "$ABWEICHUNG" ]; then
  echo "FEHLER: Repo und Live weichen nach dem Deploy ab:" >&2
  echo "$ABWEICHUNG" >&2
  exit 1
fi

( cd "$DEST" && /usr/bin/python3 -m pytest -q )

# Die plist gehoert nach ~/Library/LaunchAgents und wird dort nur ersetzt,
# wenn sie sich unterscheidet — ein Neuladen des Dienstes ist Ansagesache.
ZIEL_PLIST="$HOME/Library/LaunchAgents/$PLIST"
if ! cmp -s "$SRC/$PLIST" "$ZIEL_PLIST" 2>/dev/null; then
  cp "$SRC/$PLIST" "$ZIEL_PLIST"
  echo "plist aktualisiert -> $ZIEL_PLIST"
  echo "  Neu laden mit: launchctl bootout gui/\$UID/de.whitestag.nextcloud-backup;"
  echo "                 launchctl bootstrap gui/\$UID \"$ZIEL_PLIST\""
fi

echo "Deployt nach $DEST (Repo und Live identisch, Tests gruen)"
