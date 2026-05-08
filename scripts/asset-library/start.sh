#!/usr/bin/env bash
# Start wrapper for the Marketing Asset Library.
# Ensures `.next/` is built and fresh before exec'ing `next start`. This is what
# pm2 / launchd invoke — manual `next start` skips the build check on purpose.
#
# Behavior:
#   - If `.next/BUILD_ID` is missing OR `package.json` / `package-lock.json` /
#     `next.config.mjs` / source files in `app/` are newer than the build,
#     run `npm run build` (in production mode) before starting.
#   - Always exec `next start` at the end so pm2 supervises the actual server,
#     not the build.
#
# Pinned to homebrew node@20 (Next 14/16 prerender breaks on system Node 25).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

NODE_BIN_DIR="/opt/homebrew/opt/node@20/bin"
if [[ -d "$NODE_BIN_DIR" ]]; then
  export PATH="$NODE_BIN_DIR:$PATH"
fi
export NODE_ENV=production

BUILD_ID_FILE=".next/BUILD_ID"

needs_build() {
  if [[ ! -f "$BUILD_ID_FILE" ]]; then
    echo "[asset-library] no .next/BUILD_ID — building"
    return 0
  fi
  # Rebuild if any of these are newer than the existing build artifact.
  local newer
  newer=$(find package.json package-lock.json next.config.mjs tailwind.config.ts \
    postcss.config.mjs tsconfig.json app -newer "$BUILD_ID_FILE" -print -quit 2>/dev/null || true)
  if [[ -n "$newer" ]]; then
    echo "[asset-library] stale build (newer than .next/BUILD_ID): $newer"
    return 0
  fi
  return 1
}

build_failed=0
if needs_build; then
  echo "[asset-library] running: npm run build"
  if ! npm run build; then
    build_failed=1
    if [[ -f "$BUILD_ID_FILE" ]]; then
      echo "[asset-library] build FAILED — falling back to existing .next/ artifact" >&2
    else
      echo "[asset-library] build FAILED and no prior .next/ — cannot start; exiting" >&2
      exit 1
    fi
  fi
else
  echo "[asset-library] build is fresh — skipping rebuild"
fi

if [[ "$build_failed" == "1" ]]; then
  # Refresh BUILD_ID mtime so we don't immediately retry the failing build on
  # every pm2 restart loop — operator must touch a source file to retry.
  touch "$BUILD_ID_FILE"
fi

exec node node_modules/.bin/next start
