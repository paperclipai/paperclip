#!/usr/bin/env bash
# Deploy des LLM-Nutzungs-Reports nach ~/.paperclip/scripts/llm-usage/.
# macOS launchd kann CloudStorage/SynologyDrive nicht lesen -> Live-Kopie unter ~/.paperclip.
#
# Bewusst OHNE fest verdrahtete Dateiliste: eine solche Liste hat bei der
# Websuche schon dazu gefuehrt, dass ein neues Modul still nicht mitdeployt
# wurde. Hier wird nach Muster kopiert und danach verglichen.
#
# Tests werden MITdeployt. Ein Deploy, das `test_*.py` ausschliesst, nimmt dem
# Live-Stand die Faehigkeit zu merken, dass ihm etwas fehlt — genau daran ist
# der Jarvis-Bot ueber Wochen auseinandergelaufen.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$REPO_ROOT/tools/llm-usage"
DEST="$HOME/.paperclip/scripts/llm-usage"

mkdir -p "$DEST"

# state/ bleibt unangetastet: dort liegt das XLSX-Archiv des Digests.
# Die .plist gehoert nach ~/Library/LaunchAgents, nicht in den Skriptordner.
rsync -a --delete \
  --exclude 'state/' \
  --exclude '__pycache__/' \
  --exclude '.pytest_cache/' \
  --exclude 'deploy.sh' \
  --exclude 'README.md' \
  --exclude '*.plist' \
  "$SRC/" "$DEST/"

# Gegenprobe: was hier durchrutscht, faellt sonst erst Wochen spaeter auf.
ABWEICHUNG=$(diff -rq \
  --exclude 'state' --exclude '__pycache__' --exclude '.pytest_cache' \
  --exclude 'deploy.sh' --exclude 'README.md' --exclude '*.plist' \
  "$SRC" "$DEST" || true)
if [ -n "$ABWEICHUNG" ]; then
  echo "FEHLER: Repo und Live weichen nach dem Deploy ab:" >&2
  echo "$ABWEICHUNG" >&2
  exit 1
fi

# Tests am Zielort — deployt wird nur, was dort auch laeuft.
( cd "$DEST" && /usr/bin/python3 -m pytest -q )

echo "Deployt nach $DEST (Repo und Live identisch, Tests gruen)"
echo "Hinweis: de.whitestag.llm-usage-digest.plist gehoert nach ~/Library/LaunchAgents/"
