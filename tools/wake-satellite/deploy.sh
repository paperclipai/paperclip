#!/usr/bin/env bash
# Deploy des Wake-Word-Satelliten nach ~/.paperclip/scripts/wake-satellite/.
# macOS launchd kann CloudStorage/SynologyDrive nicht lesen -> Live-Kopie unter ~/.paperclip.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_SAT="$REPO_ROOT/tools/wake-satellite"
SRC_VCO="$REPO_ROOT/tools/voice-echo-bot"
DEST="$HOME/.paperclip/scripts/wake-satellite"
MODEL_SRC="$REPO_ROOT/hey_jarvis_v0.1.tflite"

mkdir -p "$DEST/models" "$HOME/.paperclip/logs"

# Satellit-Module
for f in wake.py capture.py playback.py earcon.py sat_config.py satellite.py; do
  cp "$SRC_SAT/$f" "$DEST/$f"
done
# Geteilte voice-echo-bot-Module (ein config.py, keine Kollision)
for f in config.py llm.py vault_client.py paperclip_client.py transcribe.py tts.py jarvis_brain.py; do
  cp "$SRC_VCO/$f" "$DEST/$f"
done
# Wake-Modell
cp "$MODEL_SRC" "$DEST/models/hey_jarvis_v0.1.tflite"

# venv
if [ ! -d "$DEST/venv" ]; then
  python3 -m venv "$DEST/venv"
fi
"$DEST/venv/bin/pip" install --upgrade pip
"$DEST/venv/bin/pip" install -r "$SRC_SAT/requirements.txt"

# Modell-Ladbarkeit prüfen (scheitert früh statt im Crashloop)
"$DEST/venv/bin/python3" -c "from openwakeword.model import Model; \
Model(wakeword_models=['$DEST/models/hey_jarvis_v0.1.tflite'], inference_framework='tflite'); \
print('openwakeword: Modell geladen ✓')"

# LaunchAgent installieren
PLIST_DEST="$HOME/Library/LaunchAgents/de.whitestag.wake-satellite.plist"
sed "s#__HOME__#$HOME#g" "$SRC_SAT/de.whitestag.wake-satellite.plist" > "$PLIST_DEST"

echo "Deploy fertig. Nächste Schritte (siehe DEPLOY.md):"
echo "  1) Mikrofon-Freigabe für $DEST/venv/bin/python3 in Systemeinstellungen."
echo "  2) launchctl bootstrap gui/\$(id -u) $PLIST_DEST"
