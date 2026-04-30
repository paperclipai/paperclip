#!/usr/bin/env bash
# Snapshot ~/.paperclip (embedded Postgres + state) into a tarball.
# Run via launchd or cron daily.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$ROOT/scripts/backups"
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/paperclip-$STAMP.tar.gz"

echo "Backing up ~/.paperclip → $OUT"
tar -czf "$OUT" -C "$HOME" .paperclip

# Keep last 14
ls -1t "$BACKUP_DIR"/paperclip-*.tar.gz 2>/dev/null | tail -n +15 | xargs -I{} rm -f {}

echo "Done. Backups:"
ls -lh "$BACKUP_DIR"/paperclip-*.tar.gz | tail -5
