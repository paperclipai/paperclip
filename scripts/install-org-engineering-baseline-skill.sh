#!/usr/bin/env bash
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/skills/org-engineering-baseline"
DEST_ROOT="${CODEX_HOME:-$HOME/.codex}/skills"
DEST_DIR="$DEST_ROOT/org-engineering-baseline"

mkdir -p "$DEST_ROOT"
rm -rf "$DEST_DIR"
cp -R "$SRC_DIR" "$DEST_DIR"

echo "Installed skill to: $DEST_DIR"
echo "Next step: reference org-engineering-baseline in ~/.codex/AGENTS.md"
