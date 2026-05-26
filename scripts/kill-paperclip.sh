#!/usr/bin/env bash
#
# kill-paperclip.sh — Cross-platform killer for Paperclip background processes.
#
# Usage:
#   scripts/kill-paperclip.sh        # kill all paperclip-related processes
#   scripts/kill-paperclip.sh --dry  # preview only
#   scripts/kill-paperclip.sh --clean-data  # also remove data/pglite
#
# On Windows (Git Bash / MSYS), this delegates to the PowerShell script
# for reliable process enumeration via WMI.
# On macOS/Linux, it uses the existing kill-dev.sh logic.
#

set -euo pipefail

DRY_RUN=false
CLEAN_DATA=false

for arg in "$@"; do
  case "$arg" in
    --dry|--dry-run|-n) DRY_RUN=true ;;
    --clean-data) CLEAN_DATA=true ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Windows: delegate to PowerShell ──────────────────────────────────────────

if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" || -n "${MSYSTEM:-}" ]]; then
  PS_ARGS=""
  if [[ "$DRY_RUN" == true ]]; then PS_ARGS="$PS_ARGS -DryRun"; fi
  if [[ "$CLEAN_DATA" == true ]]; then PS_ARGS="$PS_ARGS -CleanData"; fi

  # Try pwsh first, then powershell
  if command -v pwsh &>/dev/null; then
    pwsh -NoProfile -ExecutionPolicy Bypass -File "$SCRIPT_DIR/kill-paperclip.ps1" $PS_ARGS
  elif command -v powershell &>/dev/null; then
    powershell -NoProfile -ExecutionPolicy Bypass -File "$SCRIPT_DIR/kill-paperclip.ps1" $PS_ARGS
  else
    echo "ERROR: PowerShell not found. Cannot enumerate Windows processes reliably." >&2
    echo "Please install PowerShell or run: taskkill /F /IM postgres.exe /IM node.exe" >&2
    exit 1
  fi
  exit 0
fi

# ─── Unix (macOS/Linux): use existing kill-dev.sh + extras ────────────────────

echo "[kill-paperclip] Using Unix mode (kill-dev.sh + vitest + browsers)..."

# Run existing scripts
"$SCRIPT_DIR/kill-dev.sh" $(if [[ "$DRY_RUN" == true ]]; then echo "--dry"; fi)
"$SCRIPT_DIR/kill-vitest.sh" $(if [[ "$DRY_RUN" == true ]]; then echo "--dry"; fi)
"$SCRIPT_DIR/kill-agent-browsers.sh" $(if [[ "$DRY_RUN" == true ]]; then echo "--dry"; fi)

# Clean data directories if requested
if [[ "$CLEAN_DATA" == true && "$DRY_RUN" == false ]]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  if [[ -d "$REPO_ROOT/data/pglite" ]]; then
    echo "[kill-paperclip] Removing $REPO_ROOT/data/pglite ..."
    rm -rf "$REPO_ROOT/data/pglite"
  fi
fi

echo "[kill-paperclip] Done."
