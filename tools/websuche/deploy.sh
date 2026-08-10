#!/bin/zsh
# Spiegelt tools/websuche/ nach ~/.paperclip/scripts/websuche/.
# ~/.paperclip/scripts ist KEIN Repo — Quelle ist immer dieses Verzeichnis.
set -eu

QUELLE="$(cd "$(dirname "$0")" && pwd)"
ZIEL="$HOME/.paperclip/scripts/websuche"

mkdir -p "$ZIEL" "$HOME/.paperclip/logs"

rsync -a --delete \
  --exclude 'venv/' --exclude '__pycache__/' --exclude 'test_*.py' \
  --exclude '*.plist' --exclude 'deploy.sh' \
  "$QUELLE/" "$ZIEL/"

# Das venv wird im Ziel eigenstaendig aufgebaut, nicht mitkopiert: ein
# gespiegeltes venv traegt absolute Pfade aus dem Quellverzeichnis.
if [ ! -x "$ZIEL/venv/bin/python" ]; then
  /opt/homebrew/bin/python3.11 -m venv "$ZIEL/venv"
fi
"$ZIEL/venv/bin/pip" install -q -r "$ZIEL/requirements.txt"

cp "$QUELLE/de.whitestag.searxng.plist" "$HOME/Library/LaunchAgents/"
cp "$QUELLE/de.whitestag.websuche.plist" "$HOME/Library/LaunchAgents/"

echo "Ausgeliefert nach $ZIEL"
echo "Dienste laden:"
echo "  launchctl bootstrap gui/\$UID ~/Library/LaunchAgents/de.whitestag.searxng.plist"
echo "  launchctl bootstrap gui/\$UID ~/Library/LaunchAgents/de.whitestag.websuche.plist"
