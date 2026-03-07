#!/usr/bin/env bash
set -euo pipefail

# release.sh — One-command version bump, build, and publish via Changesets.
#
# Usage:
#   ./scripts/release.sh patch                  # 0.2.0 → 0.2.1
#   ./scripts/release.sh minor                  # 0.2.0 → 0.3.0
#   ./scripts/release.sh major                  # 0.2.0 → 1.0.0
#   ./scripts/release.sh patch --dry-run        # everything except npm publish
#   ./scripts/release.sh patch --canary          # publish under @canary tag, no commit/tag
#   ./scripts/release.sh patch --canary --dry-run
#   ./scripts/release.sh --promote 0.2.8        # promote canary to @latest + commit/tag
#   ./scripts/release.sh --promote 0.2.8 --dry-run
#
# Steps (normal):
#   1. Preflight checks (clean tree, npm login)
#   2. Auto-create a changeset for all public packages
#   3. Run changeset version (bumps versions, generates CHANGELOGs)
#   4. Build all packages
#   5. Build CLI bundle (esbuild)
#   6. Publish to npm via changeset publish (unless --dry-run)
#   7. Commit and tag
#
# --canary: Steps 1-5 unchanged, Step 6 publishes with --tag canary, Step 7 skipped.
# --promote: Skips Steps 1-6, promotes canary to latest, then commits and tags.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI_DIR="$REPO_ROOT/cli"

# ── Helper: create GitHub Release ────────────────────────────────────────────
create_github_release() {
  local version="$1"
  local is_dry_run="$2"
  local release_notes="$REPO_ROOT/releases/v${version}.md"

  if [ "$is_dry_run" = true ]; then
    echo "  [dry-run] gh release create v$version"
    return
  fi

  if ! command -v gh &>/dev/null; then
    echo "  ⚠ gh CLI not found — skipping GitHub Release"
    return
  fi

  local gh_args=(gh release create "v$version" --title "v$version")
  if [ -f "$release_notes" ]; then
    gh_args+=(--notes-file "$release_notes")
  else
    gh_args+=(--generate-notes)
  fi

  if "${gh_args[@]}"; then
    echo "  ✓ Created GitHub Release v$version"
  else
    echo "  ⚠ GitHub Release creation failed (non-fatal)"
  fi
}

# ── Parse args ────────────────────────────────────────────────────────────────

dry_run=false
canary=false
promote=false
promote_version=""
bump_type=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=true ;;
    --canary) canary=true ;;
    --promote)
      promote=true
      shift
      if [ $# -eq 0 ] || [[ "$1" == --* ]]; then
        echo "Error: --promote requires a version argument (e.g. --promote 0.2.8)"
        exit 1
      fi
      promote_version="$1"
      ;;
    *) bump_type="$1" ;;
  esac
  shift
done

if [ "$promote" = true ] && [ "$canary" = true ]; then
  echo "Error: --canary and --promote cannot be used together"
  exit 1
fi

if [ "$promote" = false ]; then
  if [ -z "$bump_type" ]; then
    echo "Usage: $0 <patch|minor|major> [--dry-run] [--canary]"
    echo "       $0 --promote <version> [--dry-run]"
    exit 1
  fi

  if [[ ! "$bump_type" =~ ^(patch|minor|major)$ ]]; then
    echo "Error: bump type must be patch, minor, or major (got '$bump_type')"
    exit 1
  fi
fi

# ── Promote mode (skips Steps 1-6) ───────────────────────────────────────────

if [ "$promote" = true ]; then
  NEW_VERSION="$promote_version"
  echo ""
  echo "==> Promote mode: promoting v$NEW_VERSION from canary to latest..."

  # Get all publishable package names
  PACKAGES=$(node -e "
const { readFileSync } = require('fs');
const { resolve } = require('path');
const root = '$REPO_ROOT';
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

  echo ""
  echo "  Promoting packages to @latest:"
  while IFS= read -r pkg; do
    if [ "$dry_run" = true ]; then
      echo "  [dry-run] npm dist-tag add ${pkg}@${NEW_VERSION} latest"
    else
      npm dist-tag add "${pkg}@${NEW_VERSION}" latest
      echo "  ✓ ${pkg}@${NEW_VERSION} → latest"
    fi
  done <<< "$PACKAGES"

  # Restore CLI dev package.json if present
  if [ -f "$CLI_DIR/package.dev.json" ]; then
    mv "$CLI_DIR/package.dev.json" "$CLI_DIR/package.json"
    echo "  ✓ Restored workspace dependencies in cli/package.json"
  fi

  # Remove the README copied for npm publishing
  if [ -f "$CLI_DIR/README.md" ]; then
    rm "$CLI_DIR/README.md"
  fi

  # Remove temporary build artifacts
  rm -rf "$REPO_ROOT/server/ui-dist"
  for pkg_dir in server packages/adapters/claude-local packages/adapters/codex-local; do
    rm -rf "$REPO_ROOT/$pkg_dir/skills"
  done

  # Stage release files, commit, and tag
  echo ""
  echo "  Committing and tagging v$NEW_VERSION..."
  if [ "$dry_run" = true ]; then
    echo "  [dry-run] git add + commit + tag v$NEW_VERSION"
  else
    git add \
      .changeset/ \
      '**/CHANGELOG.md' \
      '**/package.json' \
      cli/src/index.ts
    git commit -m "chore: release v$NEW_VERSION"
    git tag "v$NEW_VERSION"
    echo "  ✓ Committed and tagged v$NEW_VERSION"
  fi

  create_github_release "$NEW_VERSION" "$dry_run"

  echo ""
  if [ "$dry_run" = true ]; then
    echo "Dry run complete for promote v$NEW_VERSION."
    echo "  - Would promote all packages to @latest"
    echo "  - Would commit and tag v$NEW_VERSION"
    echo "  - Would create GitHub Release"
  else
    echo "Promoted all packages to @latest at v$NEW_VERSION"
    echo ""
    echo "Verify: npm view paperclipai@latest version"
    echo ""
    echo "To push:"
    echo "  git push && git push origin v$NEW_VERSION"
  fi
  exit 0
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
  'packages/adapters/claude-local', 'packages/adapters/codex-local', 'packages/adapters/opencode-local', 'packages/adapters/openclaw',
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
pnpm --filter @paperclipai/adapter-opencode-local build
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
  if [ "$canary" = true ]; then
    echo "==> Step 6/7: Skipping publish (--dry-run, --canary)"
  else
    echo "==> Step 6/7: Skipping publish (--dry-run)"
  fi
  echo ""
  echo "  Preview what would be published:"
  for dir in packages/shared packages/adapter-utils packages/db \
             packages/adapters/claude-local packages/adapters/codex-local packages/adapters/opencode-local packages/adapters/openclaw \
             server cli; do
    echo "  --- $dir ---"
    cd "$REPO_ROOT/$dir"
    npm pack --dry-run 2>&1 | tail -3
  done
  cd "$REPO_ROOT"
  if [ "$canary" = true ]; then
    echo ""
    echo "  [dry-run] Would publish with: npx changeset publish --tag canary"
  fi
else
  echo ""
  if [ "$canary" = true ]; then
    echo "==> Step 6/7: Publishing to npm (canary)..."
    cd "$REPO_ROOT"
    npx changeset publish --tag canary
    echo "  ✓ Published all packages under @canary tag"
  else
    echo "==> Step 6/7: Publishing to npm..."
    cd "$REPO_ROOT"
    npx changeset publish
    echo "  ✓ Published all packages"
  fi
fi

# ── Step 7: Restore CLI dev package.json and commit ──────────────────────────

echo ""
if [ "$canary" = true ]; then
  echo "==> Step 7/7: Skipping commit and tag (canary mode — promote later)..."
else
  echo "==> Step 7/7: Restoring dev package.json, committing, and tagging..."
fi
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

if [ "$canary" = false ]; then
  # Stage only release-related files (avoid sweeping unrelated changes with -A)
  git add \
    .changeset/ \
    '**/CHANGELOG.md' \
    '**/package.json' \
    cli/src/index.ts
  git commit -m "chore: release v$NEW_VERSION"
  git tag "v$NEW_VERSION"
  echo "  ✓ Committed and tagged v$NEW_VERSION"
fi

if [ "$canary" = false ]; then
  create_github_release "$NEW_VERSION" "$dry_run"
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
if [ "$canary" = true ]; then
  if [ "$dry_run" = true ]; then
    echo "Dry run complete for canary v$NEW_VERSION."
    echo "  - Versions bumped, built, and previewed"
    echo "  - Dev package.json restored"
    echo "  - No commit or tag (canary mode)"
    echo ""
    echo "To actually publish canary, run:"
    echo "  ./scripts/release.sh $bump_type --canary"
  else
    echo "Published canary at v$NEW_VERSION"
    echo ""
    echo "Verify: npm view paperclipai@canary version"
    echo ""
    echo "To promote to latest:"
    echo "  ./scripts/release.sh --promote $NEW_VERSION"
  fi
elif [ "$dry_run" = true ]; then
  echo "Dry run complete for v$NEW_VERSION."
  echo "  - Versions bumped, built, and previewed"
  echo "  - Dev package.json restored"
  echo "  - Commit and tag created (locally)"
  echo "  - Would create GitHub Release"
  echo ""
  echo "To actually publish, run:"
  echo "  ./scripts/release.sh $bump_type"
else
  echo "Published all packages at v$NEW_VERSION"
  echo ""
  echo "To push:"
  echo "  git push && git push origin v$NEW_VERSION"
  echo ""
  echo "GitHub Release: https://github.com/cryppadotta/paperclip/releases/tag/v$NEW_VERSION"
fi
