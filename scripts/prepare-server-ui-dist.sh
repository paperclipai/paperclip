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

rm -rf "$SERVER_UI_DIST"
cp -r "$UI_DIST" "$SERVER_UI_DIST"
echo "  -> Copied ui/dist to server/ui-dist"

if command -v gzip >/dev/null 2>&1; then
  find "$SERVER_UI_DIST/assets" -type f \
    \( -name '*.css' -o -name '*.html' -o -name '*.js' -o -name '*.json' -o -name '*.mjs' -o -name '*.svg' -o -name '*.txt' -o -name '*.wasm' \) \
    -size +1024c \
    -exec gzip -n -9 -k -f {} \;
  echo "  -> Wrote gzip-compressed static assets"
else
  echo "  -> gzip not found; skipping precompressed static assets"
fi
