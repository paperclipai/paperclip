#!/usr/bin/env bash
set -euo pipefail

# Backup the configured Paperclip database to the configured backup directory
# (default: ~/.paperclip/instances/<instance-id>/data/backups)
#
# Usage:
#   ./scripts/backup-db.sh
#   pnpm db:backup
#
# The embedded postgres must be running (start with: pnpm dev)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"
exec pnpm paperclipai db:backup "$@"
