#!/usr/bin/env bash
set -euo pipefail

# Applies migration 0088 to the CrewBrief production database.
#
# Usage:
#   DATABASE_URL="postgres://..." ./scripts/apply-crewbrief-0088-migration.sh
#
# Or via Railway CLI (after RAILWAY_TOKEN is set):
#   railway run --service crewbrief-api -- ./scripts/apply-crewbrief-0088-migration.sh
#
# Migration 0088 adds last_active_date column + index to crewbrief_waitlist_entries.

MIGRATION_FILE="packages/db/src/migrations/0088_crewbrief_last_active_date.sql"

if [ -n "${DATABASE_URL:-}" ]; then
  echo "Running migration 0088 directly via DATABASE_URL..."
  echo ""
  echo "Migration SQL:"
  cat "$MIGRATION_FILE"
  echo ""

  # Check if psql is available
  if command -v psql &>/dev/null; then
    psql "$DATABASE_URL" -f "$MIGRATION_FILE"
    echo ""
    echo "Migration 0088 applied successfully."
  else
    echo "psql not found. Install PostgreSQL client or use the project's pnpm migrate command."
    echo "  pnpm --filter @paperclipai/db migrate"
    exit 1
  fi
elif command -v railway &>/dev/null; then
  echo "Running migration 0088 via Railway CLI..."
  railway run --service crewbrief-api -- pnpm --filter @paperclipai/db migrate
else
  echo "ERROR: Set DATABASE_URL or install Railway CLI with a valid RAILWAY_TOKEN."
  echo ""
  echo "Option 1: Direct connection"
  echo "  DATABASE_URL=\"postgres://...\" $0"
  echo ""
  echo "Option 2: Railway CLI (requires RAILWAY_TOKEN)"
  echo "  railway run --service crewbrief-api -- pnpm --filter @paperclipai/db migrate"
  echo ""
  echo "Option 3: Trigger GitHub Actions deploy (auto-applies on startup)"
  echo "  Push to master branch (after RAILWAY_TOKEN secret is configured)"
  exit 1
fi
