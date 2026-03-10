#!/usr/bin/env bash
set -euo pipefail

# prepare-server-ui-dist.sh — Build the UI and copy it into server/ui-dist.
# This keeps @paperclipai/server publish artifacts self-contained for static UI serving.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UI_DIST="$REPO_ROOT/ui/dist"
SERVER_UI_DIST="$REPO_ROOT/server/ui-dist"

echo "  -> Building @paperclipai/ui..."
pnpm --dir "$REPO_ROOT" --filter @paperclipai/ui build

if [ ! -f "$UI_DIST/index.html" ]; then
  echo "Error: UI build output missing at $UI_DIST/index.html"
  exit 1
fi

rm -rf "$SERVER_UI_DIST"
cp -r "$UI_DIST" "$SERVER_UI_DIST"
echo "  -> Copied ui/dist to server/ui-dist"
