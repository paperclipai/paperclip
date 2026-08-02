#!/usr/bin/env bash
# Richtet ComfyUI headless als LaunchAgent auf dem MacBook ein (von der Studio aus).
set -euo pipefail

NODE_HOST="${NODE_HOST:-walterschonenbrocher@192.168.2.40}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="de.whitestag.comfyui-node"

REMOTE_HOME="$(ssh -o BatchMode=yes "$NODE_HOST" 'echo $HOME')"
echo "Ziel-Home: $REMOTE_HOME"

# Pflichtpfade prüfen, bevor irgendetwas installiert wird
ssh -o BatchMode=yes "$NODE_HOST" '
  set -e
  test -x "$HOME/ComfyUI-Installs/ComfyUI/ComfyUI/.venv/bin/python" || { echo "venv fehlt"; exit 1; }
  test -f "$HOME/ComfyUI-Installs/ComfyUI/ComfyUI/main.py" || { echo "main.py fehlt"; exit 1; }
  test -f "$HOME/Library/Application Support/Comfy Desktop/shared_model_paths.yaml" || { echo "Modellpfade fehlen"; exit 1; }
  "$HOME/ComfyUI-Installs/ComfyUI/ComfyUI/.venv/bin/python" -c "import torch; assert torch.backends.mps.is_available()"
  echo "Vorbedingungen ok"
'

sed "s#__HOME__#$REMOTE_HOME#g" "$SRC_DIR/$LABEL.plist" \
  | ssh -o BatchMode=yes "$NODE_HOST" "mkdir -p \$HOME/Library/LaunchAgents && cat > \$HOME/Library/LaunchAgents/$LABEL.plist"

ssh -o BatchMode=yes "$NODE_HOST" "
  launchctl bootout gui/\$(id -u)/$LABEL 2>/dev/null || true
  launchctl bootstrap gui/\$(id -u) \$HOME/Library/LaunchAgents/$LABEL.plist
  launchctl kickstart -k gui/\$(id -u)/$LABEL
"
echo "LaunchAgent installiert. Warte auf Port 8189 ..."

for i in $(seq 1 60); do
  if curl -s -m 3 -o /dev/null "http://192.168.2.40:8189/system_stats"; then
    echo "Knoten antwortet auf 8189."
    exit 0
  fi
  sleep 2
done
echo "Knoten antwortet nicht innerhalb 120 s — Log prüfen:" >&2
ssh -o BatchMode=yes "$NODE_HOST" 'tail -30 $HOME/Library/Logs/comfyui-node.err.log' >&2
exit 1
