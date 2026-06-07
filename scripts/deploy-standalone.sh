#!/usr/bin/env bash
set -euo pipefail

# deploy-standalone.sh — canonical, bootable replacement for raw `pnpm deploy`.
# (TON-2276 — root cause of the TON-2274 live crash loop.)
#
# DO NOT cut over LIVE with a bare `pnpm deploy`: it ships DEV package.json files
# (exports -> ./src/*.ts) and skips the publish lifecycle, producing an artifact
# that crash-loops and serves API-only. This script produces a self-contained
# directory that boots, by:
#   1. building all workspace packages (dist/)
#   2. `pnpm deploy` of the CLI into <outDir>
#   3. finalize: overlay publishConfig + populate server ui-dist
#   4. verify the artifact is bootable (hard gate)
#
# Usage:
#   scripts/deploy-standalone.sh <outDir> [--filter <pkg>] [--skip-build]
#
# Example:
#   scripts/deploy-standalone.sh /Volumes/Data/paperclip-backups/standalone-out
#
# After this succeeds, verify in an ISOLATED port/DB instance before any live
# swap (see the issue: never blind-cutover LIVE again).

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

OUT_DIR="${1:?usage: deploy-standalone.sh <outDir> [--filter <pkg>] [--skip-build]}"
shift || true

FILTER="@paperclipai/server"
SKIP_BUILD=false
while [ $# -gt 0 ]; do
  case "$1" in
    --filter) FILTER="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=true; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

echo "==> deploy-standalone -> $OUT_DIR (filter: $FILTER)"

# ── Step 1: build all packages so dist/ exists ──────────────────────────────────
if [ "$SKIP_BUILD" = false ]; then
  echo "  [1/4] Building workspace packages..."
  pnpm run preflight:workspace-links
  pnpm -r build
else
  echo "  [1/4] Skipping build (--skip-build)"
fi

# ── Step 2: pnpm deploy into a clean output dir ─────────────────────────────────
echo "  [2/4] pnpm deploy..."
rm -rf "$OUT_DIR"
# Force the FLAT (hoisted) node_modules layout the deployed package expects.
# pnpm 9.15.x rejects the old `--legacy` flag ("Unknown option: 'legacy'"); the
# default deploy uses the isolated/symlinked linker. `--node-linker=hoisted`
# reproduces the flat real-directory layout `--legacy` used to give. (TON-2280)
pnpm --filter "$FILTER" deploy --prod --node-linker=hoisted "$OUT_DIR"

# ── Step 3: finalize (publishConfig overlay + ui-dist) ──────────────────────────
echo "  [3/4] Finalizing..."
bash "$REPO_ROOT/scripts/finalize-standalone-deploy.sh" "$OUT_DIR"

# ── Step 4: done — verification ran inside finalize ─────────────────────────────
echo "  [4/4] Done."
echo ""
echo "Bootable standalone artifact: $OUT_DIR"
echo "NEXT: boot it on an isolated PAPERCLIP_PORT + temp DB before any live swap."
