#!/usr/bin/env bash
# Ejecuta el runbook (2026-11-03-replicar-egm.md) en un HOME limpio, como si
# fuera un host nuevo, y termina con el health check.
#   bash egm-cleanroom-check.sh [destino]
set -uo pipefail
DEST="${1:-/tmp/egm-clean}"
H="$DEST/home"
RULE="${RULE_FILE:-/home/paperclip/2026-11-03-egm-default-methodology-host-rule.md}"
INSTALLER="${INSTALLER:-/home/paperclip/egm-install-config.js}"
HEALTH="${HEALTH:-/home/paperclip/egm-health.sh}"
rm -rf "$DEST"; mkdir -p "$H"
echo "=== clean room: $DEST (HOME=$H) ==="
echo "--- pasos 1 a 4 del runbook (instalador consolidado) ---"
HOME="$H" node "$INSTALLER" --home "$H" --rule "$RULE" \
  --artifacts "$DEST/artifacts" --projects "$DEST/projects" 2>&1 | sed 's/^/  /'
echo "--- paso 5: health check contra el HOME limpio ---"
HOME="$H" XDG_CONFIG_HOME="$H/.config" EGM_BUNDLE="$H/egm-opencode-v1" \
  bash "$HEALTH" 2>&1 | grep -vE "^  info" | tail -24
