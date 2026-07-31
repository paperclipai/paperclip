#!/usr/bin/env bash
set -euo pipefail

# prepare-server-ui-dist.sh — Build the UI and copy it into server/ui-dist.
# This keeps @paperclipai/server publish artifacts self-contained for static UI serving.
# When PAPERCLIP_RELEASE_REUSE_UI_DIST=1 and ui/dist already exists, reuse that
# output instead of rebuilding it again inside the release packaging flow.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UI_DIST="$REPO_ROOT/ui/dist"
SERVER_UI_DIST="$REPO_ROOT/server/ui-dist"

should_reuse_existing_ui_dist=false
case "${PAPERCLIP_RELEASE_REUSE_UI_DIST:-}" in
  1|true|TRUE|yes|YES)
    should_reuse_existing_ui_dist=true
    ;;
esac

if [ "$should_reuse_existing_ui_dist" = true ] && [ -f "$UI_DIST/index.html" ]; then
  echo "  -> Reusing existing @paperclipai/ui dist output"
else
  echo "  -> Building @paperclipai/ui..."
  pnpm --dir "$REPO_ROOT" --filter @paperclipai/ui build
fi

if [ ! -f "$UI_DIST/index.html" ]; then
  echo "Error: UI build output missing at $UI_DIST/index.html"
  exit 1
fi

STAGED_SERVER_UI_DIST="$(mktemp -d "$REPO_ROOT/server/.ui-dist-stage.XXXXXX")"
PREVIOUS_SERVER_UI_DIST="$REPO_ROOT/server/.ui-dist-previous.$$"
cleanup_staged_ui_dist() {
  rm -rf "$STAGED_SERVER_UI_DIST" "$PREVIOUS_SERVER_UI_DIST" || true
}
trap cleanup_staged_ui_dist EXIT

cp -R "$UI_DIST/." "$STAGED_SERVER_UI_DIST/"
if [ -e "$SERVER_UI_DIST" ]; then
  mv "$SERVER_UI_DIST" "$PREVIOUS_SERVER_UI_DIST"
fi
mv "$STAGED_SERVER_UI_DIST" "$SERVER_UI_DIST"
echo "  -> Copied ui/dist to server/ui-dist"
