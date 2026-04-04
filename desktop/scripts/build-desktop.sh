#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DESKTOP_DIR="$ROOT_DIR/desktop"

echo "==> Building UI..."
pnpm --filter @paperclipai/ui build

echo "==> Building server..."
pnpm --filter @paperclipai/server build

echo "==> Preparing server UI dist..."
if [ -f "$ROOT_DIR/scripts/prepare-server-ui-dist.sh" ]; then
  bash "$ROOT_DIR/scripts/prepare-server-ui-dist.sh"
else
  # Fallback: copy UI dist to server
  mkdir -p "$ROOT_DIR/server/ui-dist"
  cp -R "$ROOT_DIR/ui/dist/." "$ROOT_DIR/server/ui-dist/"
fi

echo "==> Building Electron main process..."
cd "$DESKTOP_DIR"
pnpm build:main

echo "==> Packaging Electron app..."
pnpm exec electron-builder --config electron-builder.yml "$@"

echo "==> Done! Output in desktop/release/"
