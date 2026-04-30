#!/usr/bin/env bash
# Install and load all koenig launchd agents into ~/Library/LaunchAgents.
# Safe to re-run: unloads first if already loaded, then copies + loads.
#
# Usage:
#   ./scripts/load-launchd-agents.sh            # load all
#   ./scripts/load-launchd-agents.sh watchdog   # load single agent by label suffix
#
# To disable a routine (without removing the plist from git):
#   launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.koenig.<name>.plist
#
# To reload after editing a plist:
#   ./scripts/load-launchd-agents.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_SRC="$REPO_DIR/infra/launchd"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
GUI_DOMAIN="gui/$(id -u)"

PLISTS=(
  "com.koenig.watchdog"
  "com.koenig.paperclip-keepalive"
  "com.koenig.ceo-daily-triage"
  "com.koenig.ceo-eod-digest"
  "com.koenig.publish-action"
)

FILTER="${1:-}"

load_plist() {
  local label="$1"
  local src="$PLIST_SRC/${label}.plist"
  local dst="$LAUNCH_AGENTS/${label}.plist"

  if [[ ! -f "$src" ]]; then
    echo "  SKIP  $label (source not found at $src)"
    return
  fi

  # Unload if already loaded (suppress error if not loaded)
  launchctl bootout "$GUI_DOMAIN" "$dst" 2>/dev/null || true

  cp "$src" "$dst"
  chmod 644 "$dst"

  launchctl bootstrap "$GUI_DOMAIN" "$dst"
  echo "  OK    $label"
}

echo "=== koenig launchd agent loader ==="
echo "Source: $PLIST_SRC"
echo "Target: $LAUNCH_AGENTS"
echo ""

for label in "${PLISTS[@]}"; do
  if [[ -n "$FILTER" && "$label" != *"$FILTER"* ]]; then
    continue
  fi
  load_plist "$label"
done

echo ""
echo "=== loaded koenig agents ==="
launchctl list | grep koenig || echo "(none found — Paperclip may not be running yet)"
