#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$DESKTOP_DIR/.." && pwd)"
APP_DIR="$DESKTOP_DIR/.app-stage"

echo "==> Cleaning staging directory..."
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"

echo "==> Building combined package.json with all dependencies..."
node -e "
const fs = require('fs');
const path = require('path');

const desktopPkg = require('$DESKTOP_DIR/package.json');

// Collect all non-workspace deps from all workspace packages
const allDeps = {};
const pkgDirs = [
  '$ROOT_DIR/server',
  ...fs.readdirSync('$ROOT_DIR/packages', { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join('$ROOT_DIR/packages', d.name)),
  ...fs.existsSync('$ROOT_DIR/packages/adapters')
    ? fs.readdirSync('$ROOT_DIR/packages/adapters', { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => path.join('$ROOT_DIR/packages/adapters', d.name))
    : [],
  ...fs.existsSync('$ROOT_DIR/packages/plugins')
    ? fs.readdirSync('$ROOT_DIR/packages/plugins', { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => path.join('$ROOT_DIR/packages/plugins', d.name))
    : [],
];

for (const dir of pkgDirs) {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) continue;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    for (const [name, version] of Object.entries(pkg.dependencies || {})) {
      if (name.startsWith('hermes-')) continue;
      // For workspace packages, add with wildcard version (they're copied manually)
      if (name.startsWith('@paperclipai/')) {
        allDeps[name] = '*';
      } else {
        allDeps[name] = version;
      }
    }
  } catch(e) {}
}

// Merge desktop prod deps
for (const [name, version] of Object.entries(desktopPkg.dependencies || {})) {
  if (version.startsWith('workspace:')) {
    allDeps[name] = '*'; // workspace packages are copied manually
  } else {
    allDeps[name] = version;
  }
}

const outputPkg = {
  name: desktopPkg.name,
  version: desktopPkg.version,
  private: true,
  main: desktopPkg.main,
  type: desktopPkg.type,
  dependencies: allDeps,
};

fs.writeFileSync('$APP_DIR/package.json', JSON.stringify(outputPkg, null, 2));
console.log('Combined ' + Object.keys(allDeps).length + ' dependencies');
"

echo "==> Installing all npm dependencies (flat node_modules)..."
cd "$APP_DIR"
npm install --production --ignore-scripts --legacy-peer-deps 2>&1 | tail -5

echo "==> Copying desktop dist (compiled main process)..."
cp -R "$DESKTOP_DIR/dist" "$APP_DIR/dist"

echo "==> Copying resources..."
[ -d "$DESKTOP_DIR/resources" ] && cp -R "$DESKTOP_DIR/resources" "$APP_DIR/resources"

echo "==> Copying workspace packages (AFTER npm install so they don't get wiped)..."

# Server — use publishConfig exports (compiled JS) instead of dev exports (.ts source)
mkdir -p "$APP_DIR/node_modules/@paperclipai/server"
node -e "
const pkg = require('$ROOT_DIR/server/package.json');
// Replace dev exports (./src/index.ts) with compiled exports (./dist/index.js)
if (pkg.publishConfig && pkg.publishConfig.exports) {
  pkg.exports = pkg.publishConfig.exports;
  pkg.main = pkg.publishConfig.main;
  pkg.types = pkg.publishConfig.types;
}
require('fs').writeFileSync('$APP_DIR/node_modules/@paperclipai/server/package.json', JSON.stringify(pkg, null, 2));
"
cp -R "$ROOT_DIR/server/dist" "$APP_DIR/node_modules/@paperclipai/server/dist"

# UI dist into server
if [ -d "$ROOT_DIR/ui/dist" ]; then
  mkdir -p "$APP_DIR/node_modules/@paperclipai/server/ui-dist"
  cp -R "$ROOT_DIR/ui/dist/." "$APP_DIR/node_modules/@paperclipai/server/ui-dist/"
fi

# Helper: copy a workspace package with publishConfig exports override
copy_workspace_pkg() {
  local src_dir="$1"
  [ ! -f "${src_dir}/package.json" ] && return
  local pkg_name
  pkg_name=$(node -e "console.log(require('${src_dir}/package.json').name)" 2>/dev/null) || return
  [ -z "$pkg_name" ] && return
  local target_dir="$APP_DIR/node_modules/$pkg_name"
  mkdir -p "$target_dir"

  # Rewrite package.json: use publishConfig exports if available
  node -e "const pkg=require('${src_dir}/package.json');if(pkg.publishConfig){if(pkg.publishConfig.exports)pkg.exports=pkg.publishConfig.exports;if(pkg.publishConfig.main)pkg.main=pkg.publishConfig.main;if(pkg.publishConfig.types)pkg.types=pkg.publishConfig.types}require('fs').writeFileSync('${target_dir}/package.json',JSON.stringify(pkg,null,2))"
  [ -d "${src_dir}/dist" ] && cp -R "${src_dir}/dist" "$target_dir/dist"
  # Only copy src if no dist exists (some packages may only have source)
  if [ ! -d "${src_dir}/dist" ] && [ -d "${src_dir}/src" ]; then
    cp -R "${src_dir}/src" "$target_dir/src"
  fi
  [ -d "${src_dir}/drizzle" ] && cp -R "${src_dir}/drizzle" "$target_dir/drizzle"
  echo "  copied $pkg_name"
}

# Core packages
for pkg_dir in "$ROOT_DIR"/packages/*/; do
  copy_workspace_pkg "$pkg_dir"
done

# Adapters
for adapter_dir in "$ROOT_DIR"/packages/adapters/*/; do
  copy_workspace_pkg "$adapter_dir"
done

# Plugins
for plugin_dir in "$ROOT_DIR"/packages/plugins/*/; do
  copy_workspace_pkg "$plugin_dir"
done

echo ""
echo "==> Staging complete!"
du -sh "$APP_DIR" 2>/dev/null || true

echo "==> Verifying critical modules..."
ALL_OK=true
for mod in "@paperclipai/server" "@paperclipai/db" "@paperclipai/shared" electron-updater builder-util-runtime express ws embedded-postgres drizzle-orm tsx sharp; do
  if [ -d "$APP_DIR/node_modules/$mod" ]; then
    echo "  ✓ $mod"
  else
    echo "  ✗ $mod MISSING"
    ALL_OK=false
  fi
done

if [ "$ALL_OK" = false ]; then
  echo "ERROR: Some modules are missing!"
  exit 1
fi

echo "==> All modules verified!"
