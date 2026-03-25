#!/bin/bash
# Fix script for Paperclip embedded-postgres platform dependency issues
# This script detects and fixes missing platform-specific embedded-postgres packages

set -e

echo "[paperclip-fix] Checking embedded-postgres dependencies..."

# Detect platform
PLATFORM=$(node -e "console.log(process.platform)")
ARCH=$(node -e "console.log(process.arch)")

case "$PLATFORM-$ARCH" in
  "darwin-arm64")
    PKG_NAME="@embedded-postgres/darwin-arm64"
    ;;
  "darwin-x64")
    PKG_NAME="@embedded-postgres/darwin-x64"
    ;;
  "linux-arm64")
    PKG_NAME="@embedded-postgres/linux-arm64"
    ;;
  "linux-x64")
    PKG_NAME="@embedded-postgres/linux-x64"
    ;;
  "win32-x64")
    PKG_NAME="@embedded-postgres/win32-x64"
    ;;
  *)
    echo "[paperclip-fix] Unsupported platform: $PLATFORM-$ARCH"
    echo "[paperclip-fix] Please check https://www.npmjs.com/package/embedded-postgres for supported platforms"
    exit 1
    ;;
esac

echo "[paperclip-fix] Platform detected: $PLATFORM-$ARCH"
echo "[paperclip-fix] Platform package: $PKG_NAME"

# Get the version of embedded-postgres from packages/db
EMBEDDED_PG_VERSION=$(node -e "
  const pkg = require('./packages/db/package.json');
  const dep = pkg.dependencies?.['embedded-postgres'];
  if (dep) {
    const match = dep.match(/(\d+\.\d+\.\d+(-[\w.]+)?)/);
    console.log(match ? match[1] : dep);
  } else {
    console.log('');
  }
")

if [ -z "$EMBEDDED_PG_VERSION" ]; then
  echo "[paperclip-fix] ERROR: Could not determine embedded-postgres version"
  exit 1
fi

echo "[paperclip-fix] embedded-postgres version: $EMBEDDED_PG_VERSION"

# Check if platform package is already installed
if node -e "require('$PKG_NAME')" 2>/dev/null; then
  echo "[paperclip-fix] Platform package $PKG_NAME is already installed"
  exit 0
fi

echo "[paperclip-fix] Platform package not found, attempting to install..."

# Extract base version (without -beta suffix) for checking available versions
BASE_VERSION=$(echo "$EMBEDDED_PG_VERSION" | sed 's/-[\w\.]*$//')

# Try to install the exact version first
if pnpm view "$PKG_NAME@$EMBEDDED_PG_VERSION" version >/dev/null 2>&1; then
  echo "[paperclip-fix] Installing $PKG_NAME@$EMBEDDED_PG_VERSION..."
  pnpm add -D "$PKG_NAME@$EMBEDDED_PG_VERSION" --filter @paperclipai/db
else
  # If exact version not found, try to find the latest matching version
  echo "[paperclip-fix] Exact version $EMBEDDED_PG_VERSION not found, finding latest compatible version..."

  # Get the latest available version
  LATEST_VERSION=$(pnpm view "$PKG_NAME" version 2>/dev/null || echo "")

  if [ -n "$LATEST_VERSION" ]; then
    echo "[paperclip-fix] Installing latest available: $PKG_NAME@$LATEST_VERSION"
    pnpm add -D "$PKG_NAME@$LATEST_VERSION" --filter @paperclipai/db
  else
    echo "[paperclip-fix] ERROR: Could not find any version of $PKG_NAME"
    exit 1
  fi
fi

echo "[paperclip-fix] Verifying installation..."
if node -e "require('$PKG_NAME')" 2>/dev/null; then
  echo "[paperclip-fix] ✓ Success! Platform package installed."
  echo "[paperclip-fix] You can now run: pnpm dev"
else
  echo "[paperclip-fix] ERROR: Installation verification failed"
  exit 1
fi
