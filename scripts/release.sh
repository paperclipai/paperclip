#!/usr/bin/env bash
set -euo pipefail

# release.sh — One-command version bump, build, and publish via Changesets.
#
# Usage:
#   ./scripts/release.sh patch          # 0.2.0 → 0.2.1
#   ./scripts/release.sh minor          # 0.2.0 → 0.3.0
#   ./scripts/release.sh major          # 0.2.0 → 1.0.0
#   ./scripts/release.sh patch --dry-run # everything except npm publish
#
# Steps:
#   1. Preflight checks (clean tree, npm login)
#   2. Auto-create a changeset for all public packages
#   3. Run changeset version (bumps versions, generates CHANGELOGs)
#   4. Build all packages
#   5. Build CLI bundle (esbuild)
#   6. Publish to npm via changeset publish (unless --dry-run)
#   7. Commit and tag

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI_DIR="$REPO_ROOT/cli"

# ── Parse args ────────────────────────────────────────────────────────────────

dry_run=false
bump_type=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=true ;;
    *) bump_type="$arg" ;;
  esac
done

if [ -z "$bump_type" ]; then
  echo "Usage: $0 <patch|minor|major> [--dry-run]"
  exit 1
fi

if [[ ! "$bump_type" =~ ^(patch|minor|major)$ ]]; then
  echo "Error: bump type must be patch, minor, or major (got '$bump_type')"
  exit 1
fi

# ── Step 1: Preflight checks ─────────────────────────────────────────────────

echo ""
echo "==> Step 1/7: Preflight checks..."

if [ "$dry_run" = false ]; then
  if ! npm whoami &>/dev/null; then
    echo "Error: Not logged in to npm. Run 'npm login' first."
    exit 1
  fi
  echo "  ✓ Logged in to npm as $(npm whoami)"
fi

if ! git -C "$REPO_ROOT" diff --quiet || ! git -C "$REPO_ROOT" diff --cached --quiet; then
  echo "Error: Working tree has uncommitted changes. Commit or stash them first."
  exit 1
fi
echo "  ✓ Working tree is clean"

# ── Step 2: Auto-create changeset ────────────────────────────────────────────

echo ""
echo "==> Step 2/7: Creating changeset ($bump_type bump for all packages)..."

# Get all publishable (non-private) package names
PACKAGES=$(node -e "
const { readdirSync, readFileSync } = require('fs');
const { resolve } = require('path');
const root = '$REPO_ROOT';
const wsYaml = readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8');
const dirs = ['packages/shared', 'packages/adapter-utils', 'packages/db',
  'packages/adapters/claude-local', 'packages/adapters/codex-local', 'packages/adapters/openclaw',
  'server', 'cli'];
const names = [];
for (const d of dirs) {
  try {
    const pkg = JSON.parse(readFileSync(resolve(root, d, 'package.json'), 'utf8'));
    if (!pkg.private) names.push(pkg.name);
  } catch {}
}
console.log(names.join('\n'));
")

# Write a changeset file
CHANGESET_FILE="$REPO_ROOT/.changeset/release-bump.md"
{
  echo "---"
  while IFS= read -r pkg; do
    echo "\"$pkg\": $bump_type"
  done <<< "$PACKAGES"
  echo "---"
  echo ""
  echo "Version bump ($bump_type)"
} > "$CHANGESET_FILE"

echo "  ✓ Created changeset for $(echo "$PACKAGES" | wc -l | xargs) packages"

# ── Step 3: Version packages ─────────────────────────────────────────────────

echo ""
echo "==> Step 3/7: Running changeset version..."
cd "$REPO_ROOT"
npx changeset version
echo "  ✓ Versions bumped and CHANGELOGs generated"

# Read the new version from the CLI package
NEW_VERSION=$(node -e "console.log(require('$CLI_DIR/package.json').version)")
echo "  New version: $NEW_VERSION"

# Update the version string in cli/src/index.ts
CURRENT_VERSION_IN_SRC=$(sed -n 's/.*\.version("\([^"]*\)".*/\1/p' "$CLI_DIR/src/index.ts" | head -1)
if [ -n "$CURRENT_VERSION_IN_SRC" ] && [ "$CURRENT_VERSION_IN_SRC" != "$NEW_VERSION" ]; then
  sed -i '' "s/\.version(\"$CURRENT_VERSION_IN_SRC\")/\.version(\"$NEW_VERSION\")/" "$CLI_DIR/src/index.ts"
  echo "  ✓ Updated cli/src/index.ts version to $NEW_VERSION"
fi

# ── Step 4: Build packages ───────────────────────────────────────────────────

echo ""
echo "==> Step 4/7: Building all packages..."
cd "$REPO_ROOT"

# Build packages in dependency order (excluding CLI)
pnpm --filter @paperclipai/shared build
pnpm --filter @paperclipai/adapter-utils build
pnpm --filter @paperclipai/db build
pnpm --filter @paperclipai/adapter-claude-local build
pnpm --filter @paperclipai/adapter-codex-local build
pnpm --filter @paperclipai/adapter-openclaw build
pnpm --filter @paperclipai/server build

# Build UI and bundle into server package for static serving
pnpm --filter @paperclipai/ui build
rm -rf "$REPO_ROOT/server/ui-dist"
cp -r "$REPO_ROOT/ui/dist" "$REPO_ROOT/server/ui-dist"

# Bundle skills into packages that need them (adapters + server)
for pkg_dir in server packages/adapters/claude-local packages/adapters/codex-local; do
  rm -rf "$REPO_ROOT/$pkg_dir/skills"
  cp -r "$REPO_ROOT/skills" "$REPO_ROOT/$pkg_dir/skills"
done
echo "  ✓ All packages built (including UI + skills)"

# ── Step 5: Build CLI bundle ─────────────────────────────────────────────────

echo ""
echo "==> Step 5/7: Building CLI bundle..."
cd "$REPO_ROOT"
"$REPO_ROOT/scripts/build-npm.sh" --skip-checks
echo "  ✓ CLI bundled"

# ── Step 6: Publish ──────────────────────────────────────────────────────────

if [ "$dry_run" = true ]; then
  echo ""
  echo "==> Step 6/7: Skipping publish (--dry-run)"
  echo ""
  echo "  Preview what would be published:"
  for dir in packages/shared packages/adapter-utils packages/db \
             packages/adapters/claude-local packages/adapters/codex-local packages/adapters/openclaw \
             server cli; do
    echo "  --- $dir ---"
    cd "$REPO_ROOT/$dir"
    npm pack --dry-run 2>&1 | tail -3
  done
  cd "$REPO_ROOT"
else
  echo ""
  echo "==> Step 6/7: Publishing to npm..."
  cd "$REPO_ROOT"
  npx changeset publish
  echo "  ✓ Published all packages"
fi

# ── Step 7: Restore CLI dev package.json and commit ──────────────────────────

echo ""
echo "==> Step 7/7: Restoring dev package.json, committing, and tagging..."
cd "$REPO_ROOT"

# Restore the dev package.json (build-npm.sh backs it up)
if [ -f "$CLI_DIR/package.dev.json" ]; then
  mv "$CLI_DIR/package.dev.json" "$CLI_DIR/package.json"
  echo "  ✓ Restored workspace dependencies in cli/package.json"
fi

# Remove the README copied for npm publishing
if [ -f "$CLI_DIR/README.md" ]; then
  rm "$CLI_DIR/README.md"
fi

# Remove temporary build artifacts before committing (these are only needed during publish)
rm -rf "$REPO_ROOT/server/ui-dist"
for pkg_dir in server packages/adapters/claude-local packages/adapters/codex-local; do
  rm -rf "$REPO_ROOT/$pkg_dir/skills"
done

# Stage only release-related files (avoid sweeping unrelated changes with -A)
git add \
  .changeset/ \
  '**/CHANGELOG.md' \
  '**/package.json' \
  cli/src/index.ts
git commit -m "chore: release v$NEW_VERSION"
git tag "v$NEW_VERSION"
echo "  ✓ Committed and tagged v$NEW_VERSION"

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
if [ "$dry_run" = true ]; then
  echo "Dry run complete for v$NEW_VERSION."
  echo "  - Versions bumped, built, and previewed"
  echo "  - Dev package.json restored"
  echo "  - Commit and tag created (locally)"
  echo ""
  echo "To actually publish, run:"
  echo "  ./scripts/release.sh $bump_type"
else
  echo "Published all packages at v$NEW_VERSION"
  echo ""
  echo "To push:"
  echo "  git push && git push origin v$NEW_VERSION"
fi
