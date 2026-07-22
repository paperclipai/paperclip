#!/usr/bin/env bash
set -euo pipefail

# build-npm.sh — Build the paperclipai CLI package for npm publishing.
#
# Uses esbuild to bundle all workspace code into a single file,
# keeping external npm dependencies as regular package dependencies.
#
# Usage:
#   ./scripts/build-npm.sh               # full build
#   ./scripts/build-npm.sh --skip-checks  # skip forbidden-token check (CI without token list)

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI_DIR="$REPO_ROOT/cli"
DIST_DIR="$CLI_DIR/dist"

skip_checks=false
skip_typecheck=false
for arg in "$@"; do
  case "$arg" in
    --skip-checks) skip_checks=true ;;
    --skip-typecheck) skip_typecheck=true ;;
  esac
done

echo "==> Building paperclipai for npm"

# ── Step 1: Forbidden token check ──────────────────────────────────────────────
if [ "$skip_checks" = false ]; then
  echo "  [1/5] Running forbidden token check..."
  node "$REPO_ROOT/scripts/check-forbidden-tokens.mjs"
else
  echo "  [1/5] Skipping forbidden token check (--skip-checks)"
fi

# ── Step 2: TypeScript type-check ──────────────────────────────────────────────
if [ "$skip_typecheck" = false ]; then
  echo "  [2/6] Type-checking..."
  cd "$REPO_ROOT"
  pnpm -r typecheck
else
  echo "  [2/6] Skipping type-check (--skip-typecheck)"
fi

# ── Step 3: Bundle CLI with esbuild ────────────────────────────────────────────
echo "  [3/6] Bundling CLI with esbuild..."
cd "$CLI_DIR"
rm -rf dist

node --input-type=module -e "
import esbuild from 'esbuild';
import config from './esbuild.config.mjs';
await esbuild.build(config);
"

chmod +x dist/index.js

# ── Step 4: Validate bundled entrypoint syntax ─────────────────────────────────
echo "  [4/6] Verifying bundled entrypoint syntax..."
node --check "$DIST_DIR/index.js"

# ── Step 5: Back up dev package.json, generate publishable one ─────────────────
echo "  [5/6] Generating publishable package.json..."
cp "$CLI_DIR/package.json" "$CLI_DIR/package.dev.json"
node "$REPO_ROOT/scripts/generate-npm-package-json.mjs"

# Copy root README so npm shows the repo README on the package page
cp "$REPO_ROOT/README.md" "$CLI_DIR/README.md"

# ── Step 6: Summary ───────────────────────────────────────────────────────────
BUNDLE_SIZE=$(wc -c < "$DIST_DIR/index.js" | xargs)
echo "  [6/6] Build verification..."
echo ""
echo "Build complete."
echo "  Bundle: cli/dist/index.js (${BUNDLE_SIZE} bytes)"
echo "  Source map: cli/dist/index.js.map"
echo ""
echo "To preview:   cd cli && npm pack --dry-run"
echo "To publish:   cd cli && npm publish --access public"
echo "To restore:   mv cli/package.dev.json cli/package.json"
