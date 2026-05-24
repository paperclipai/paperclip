#!/usr/bin/env bash
set -euo pipefail

# Backup the configured Valadrien OS database to the configured backup directory
# (default: ~/.valadrien-os/instances/<instance-id>/data/backups)
#
# Usage:
#   ./scripts/backup-db.sh
#   pnpm db:backup
#
# The embedded postgres must be running (start with: pnpm dev)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"
exec pnpm valadrien-os db:backup "$@"
