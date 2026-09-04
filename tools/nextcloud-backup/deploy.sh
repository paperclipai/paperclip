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

# Die plists gehoeren nach ~/Library/LaunchAgents und werden dort nur
# ersetzt, wenn sie sich unterscheiden — ein Neuladen des Dienstes ist
# Ansagesache. Seit dem 04.09.2026 sind es zwei: die naechtliche Sicherung
# und die monatliche Repo-Pruefung.
for QUELL_PLIST in "$SRC"/*.plist; do
  PLIST="$(basename "$QUELL_PLIST")"
  LABEL="${PLIST%.plist}"
  ZIEL_PLIST="$HOME/Library/LaunchAgents/$PLIST"
  if ! cmp -s "$QUELL_PLIST" "$ZIEL_PLIST" 2>/dev/null; then
    cp "$QUELL_PLIST" "$ZIEL_PLIST"
    echo "plist aktualisiert -> $ZIEL_PLIST"
    echo "  Neu laden mit: launchctl bootout gui/\$UID/$LABEL;"
    echo "                 launchctl bootstrap gui/\$UID \"$ZIEL_PLIST\""
  fi
done

echo "Deployt nach $DEST (Repo und Live identisch, Tests gruen)"
