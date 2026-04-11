#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/apps/neuros-macos"
APP_PACKAGE_JSON="$APP_DIR/package.json"
OUTPUT_DIR="${OUTPUT_DIR:-$APP_DIR/dist}"
INSTALL_LOCATION="${INSTALL_LOCATION:-/Applications}"

read_package_field() {
  local field="$1"

  node --input-type=module -e '
    import fs from "node:fs";

    const [packageJsonPath, fieldName] = process.argv.slice(1);
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const value = packageJson[fieldName];

    if (value === undefined) {
      process.exit(1);
    }

    process.stdout.write(String(value));
  ' "$APP_PACKAGE_JSON" "$field"
}

PRODUCT_NAME="$(read_package_field productName)"
BUNDLE_IDENTIFIER="$(read_package_field bundleIdentifier)"
VERSION="$(read_package_field version)"
PKG_PATH="$OUTPUT_DIR/${PRODUCT_NAME}-${VERSION}.pkg"
APP_BUNDLE="$("$ROOT_DIR/scripts/build-neuros-macos-app.sh")"

mkdir -p "$OUTPUT_DIR"
rm -f "$PKG_PATH"

pkgbuild \
  --component "$APP_BUNDLE" \
  --install-location "$INSTALL_LOCATION" \
  --identifier "$BUNDLE_IDENTIFIER" \
  --version "$VERSION" \
  "$PKG_PATH" >/dev/null

printf '%s\n' "$PKG_PATH"
