#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/apps/neuros-macos"
APP_PACKAGE_JSON="$APP_DIR/package.json"
OUTPUT_DIR="${OUTPUT_DIR:-$APP_DIR/dist}"

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
VERSION="$(read_package_field version)"
DMG_PATH="$OUTPUT_DIR/${PRODUCT_NAME}-${VERSION}.dmg"
STAGING_ROOT="$OUTPUT_DIR/dmg-staging"
STAGING_DIR="$STAGING_ROOT/${PRODUCT_NAME}-${VERSION}"
APP_BUNDLE="$("$ROOT_DIR/scripts/build-neuros-macos-app.sh")"

mkdir -p "$OUTPUT_DIR" "$STAGING_ROOT"
rm -f "$DMG_PATH"
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

cleanup() {
  rm -rf "$STAGING_DIR"
}

trap cleanup EXIT

ditto "$APP_BUNDLE" "$STAGING_DIR/${PRODUCT_NAME}.app"
ln -s /Applications "$STAGING_DIR/Applications"

hdiutil create \
  -volname "${PRODUCT_NAME} ${VERSION}" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH" >/dev/null

printf '%s\n' "$DMG_PATH"
