#!/usr/bin/env bash
set -euo pipefail

# prepare-server-package-assets.sh — Materialize generated files declared by
# @paperclipai/server's package manifest before the package is staged or packed.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_SKILLS="$REPO_ROOT/server/skills"

bash "$REPO_ROOT/scripts/prepare-server-ui-dist.sh"

rm -rf "$SERVER_SKILLS"
cp -r "$REPO_ROOT/skills" "$SERVER_SKILLS"
echo "  -> Copied skills to server/skills"
