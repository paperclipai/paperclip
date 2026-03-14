#!/usr/bin/env bash
set -euo pipefail

# release.sh — Prepare and publish a Paperclip release.
#
# Stable release:
#   ./scripts/release.sh patch
#   ./scripts/release.sh minor --dry-run
#
# Canary release:
#   ./scripts/release.sh patch --canary
#   ./scripts/release.sh minor --canary --dry-run
#
# Canary releases publish prerelease versions such as 1.2.3-canary.0 under the
# npm dist-tag "canary". Stable releases publish 1.2.3 under "latest".

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=./release-lib.sh
. "$REPO_ROOT/scripts/release-lib.sh"
CLI_DIR="$REPO_ROOT/cli"
TEMP_CHANGESET_FILE="$REPO_ROOT/.changeset/release-bump.md"
TEMP_PRE_FILE="$REPO_ROOT/.changeset/pre.json"

dry_run=false
canary=false
bump_type=""

cleanup_on_exit=false

usage() {
  cat <<'EOF'
Usage:
  ./scripts/release.sh <patch|minor|major> [--canary] [--dry-run]

Examples:
  ./scripts/release.sh patch
  ./scripts/release.sh minor --dry-run
  ./scripts/release.sh patch --canary
  ./scripts/release.sh minor --canary --dry-run

Notes:
  - Canary publishes prerelease versions like 1.2.3-canary.0 under the npm
    dist-tag "canary".
  - Stable publishes 1.2.3 under the npm dist-tag "latest".
  - Run this from branch release/X.Y.Z matching the computed target version.
  - Dry runs leave the working tree clean.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=true ;;
    --canary) canary=true ;;
    -h|--help)
      usage
      exit 0
      ;;
    --promote)
      echo "Error: --promote was removed. Re-run a stable release from the vetted commit instead."
      exit 1
      ;;
    *)
      if [ -n "$bump_type" ]; then
        echo "Error: only one bump type may be provided."
        exit 1
      fi
      bump_type="$1"
      ;;
  esac
  shift
done

if [[ ! "$bump_type" =~ ^(patch|minor|major)$ ]]; then
  usage
  exit 1
fi

restore_publish_artifacts() {
  if [ -f "$CLI_DIR/package.dev.json" ]; then
    mv "$CLI_DIR/package.dev.json" "$CLI_DIR/package.json"
  fi

  rm -f "$CLI_DIR/README.md"
  rm -rf "$REPO_ROOT/server/ui-dist"

  for pkg_dir in server packages/adapters/claude-local packages/adapters/codex-local; do
    rm -rf "$REPO_ROOT/$pkg_dir/skills"
  done
}

cleanup_release_state() {
  restore_publish_artifacts

  rm -f "$TEMP_CHANGESET_FILE" "$TEMP_PRE_FILE"

  tracked_changes="$(git -C "$REPO_ROOT" diff --name-only; git -C "$REPO_ROOT" diff --cached --name-only)"
  if [ -n "$tracked_changes" ]; then
    printf '%s\n' "$tracked_changes" | sort -u | while IFS= read -r path; do
      [ -z "$path" ] && continue
      git -C "$REPO_ROOT" checkout -q HEAD -- "$path" || true
    done
  fi

  untracked_changes="$(git -C "$REPO_ROOT" ls-files --others --exclude-standard)"
  if [ -n "$untracked_changes" ]; then
    printf '%s\n' "$untracked_changes" | while IFS= read -r path; do
      [ -z "$path" ] && continue
      if [ -d "$REPO_ROOT/$path" ]; then
        rm -rf "$REPO_ROOT/$path"
      else
        rm -f "$REPO_ROOT/$path"
      fi
    done
  fi
}

if [ "$cleanup_on_exit" = true ]; then
  trap cleanup_release_state EXIT
fi

set_cleanup_trap() {
  cleanup_on_exit=true
  trap cleanup_release_state EXIT
}

require_npm_publish_auth() {
  if [ "$dry_run" = true ]; then
    return
  fi

  if npm whoami >/dev/null 2>&1; then
    release_info "  ✓ Logged in to npm as $(npm whoami)"
    return
  fi

  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    release_info "  ✓ npm publish auth will be provided by GitHub Actions trusted publishing"
    return
  fi

  release_fail "npm publish auth is not available. Use 'npm login' locally or run from the GitHub release workflow."
}

list_public_package_info() {
  node - "$REPO_ROOT" <<'NODE'
const fs = require('fs');
const path = require('path');

const root = process.argv[2];
const roots = ['packages', 'server', 'ui', 'cli'];
const seen = new Set();
const rows = [];

function walk(relDir) {
  const absDir = path.join(root, relDir);
  const pkgPath = path.join(absDir, 'package.json');

  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (!pkg.private) {
      rows.push([relDir, pkg.name]);
    }
    return;
  }

  if (!fs.existsSync(absDir)) {
    return;
  }

  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    walk(path.join(relDir, entry.name));
  }
}

for (const rel of roots) {
  walk(rel);
}

rows.sort((a, b) => a[0].localeCompare(b[0]));

for (const [dir, name] of rows) {
  const pkgPath = path.join(root, dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const key = `${dir}\t${name}\t${pkg.version}`;
  if (seen.has(key)) continue;
  seen.add(key);
  process.stdout.write(`${dir}\t${name}\t${pkg.version}\n`);
}
NODE
}

replace_version_string() {
  local from_version="$1"
  local to_version="$2"

  node - "$REPO_ROOT" "$from_version" "$to_version" <<'NODE'
const fs = require('fs');
const path = require('path');

const root = process.argv[2];
const fromVersion = process.argv[3];
const toVersion = process.argv[4];

const roots = ['packages', 'server', 'ui', 'cli'];
const targets = new Set(['package.json', 'CHANGELOG.md']);
const extraFiles = [path.join('cli', 'src', 'index.ts')];

function rewriteFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const current = fs.readFileSync(filePath, 'utf8');
  if (!current.includes(fromVersion)) return;
  fs.writeFileSync(filePath, current.split(fromVersion).join(toVersion));
}

function walk(relDir) {
  const absDir = path.join(root, relDir);
  if (!fs.existsSync(absDir)) return;

  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      walk(path.join(relDir, entry.name));
      continue;
    }

    if (targets.has(entry.name)) {
      rewriteFile(path.join(absDir, entry.name));
    }
  }
}

for (const rel of roots) {
  walk(rel);
}

for (const relFile of extraFiles) {
  rewriteFile(path.join(root, relFile));
}
NODE
}

PUBLISH_REMOTE="$(resolve_release_remote)"
fetch_release_remote "$PUBLISH_REMOTE"

LAST_STABLE_TAG="$(get_last_stable_tag)"
CURRENT_STABLE_VERSION="$(get_current_stable_version)"

TARGET_STABLE_VERSION="$(compute_bumped_version "$CURRENT_STABLE_VERSION" "$bump_type")"
TARGET_PUBLISH_VERSION="$TARGET_STABLE_VERSION"
CURRENT_BRANCH="$(git_current_branch)"
EXPECTED_RELEASE_BRANCH="$(release_branch_name "$TARGET_STABLE_VERSION")"
NOTES_FILE="$(release_notes_file "$TARGET_STABLE_VERSION")"
RELEASE_TAG="v$TARGET_STABLE_VERSION"

if [ "$canary" = true ]; then
  TARGET_PUBLISH_VERSION="$(next_canary_version "$TARGET_STABLE_VERSION")"
fi

if [ "$TARGET_STABLE_VERSION" = "$CURRENT_STABLE_VERSION" ]; then
  release_fail "next stable version matches the current stable version. Refusing to publish."
fi

if [[ "$TARGET_PUBLISH_VERSION" == "${CURRENT_STABLE_VERSION}-canary."* ]]; then
  release_fail "canary versions must be derived from the next stable version, never ${CURRENT_STABLE_VERSION}-canary.N."
fi

require_clean_worktree
ensure_release_branch_for_version "$TARGET_STABLE_VERSION"

if git_local_tag_exists "$RELEASE_TAG" || git_remote_tag_exists "$RELEASE_TAG" "$PUBLISH_REMOTE"; then
  release_fail "release train $EXPECTED_RELEASE_BRANCH is frozen because tag $RELEASE_TAG already exists locally or on $PUBLISH_REMOTE."
fi

if npm_version_exists "$TARGET_STABLE_VERSION"; then
  release_fail "stable version $TARGET_STABLE_VERSION is already published on npm. Refusing to reuse release train $EXPECTED_RELEASE_BRANCH."
fi

if [ "$canary" = false ] && [ ! -f "$NOTES_FILE" ]; then
  release_fail "stable release notes file is required at $NOTES_FILE before publishing stable."
fi

if [ "$canary" = true ] && [ ! -f "$NOTES_FILE" ]; then
  release_warn "stable release notes file is missing at $NOTES_FILE. Draft it before you finalize stable."
fi

if ! git_remote_branch_exists "$EXPECTED_RELEASE_BRANCH" "$PUBLISH_REMOTE"; then
  if [ "$canary" = false ] && [ "$dry_run" = false ]; then
    release_fail "remote branch $EXPECTED_RELEASE_BRANCH does not exist on $PUBLISH_REMOTE. Run ./scripts/release-start.sh $bump_type first or push the branch before stable publish."
  fi
  release_warn "remote branch $EXPECTED_RELEASE_BRANCH does not exist on $PUBLISH_REMOTE yet."
fi

PUBLIC_PACKAGE_INFO="$(list_public_package_info)"
PUBLIC_PACKAGE_NAMES="$(printf '%s\n' "$PUBLIC_PACKAGE_INFO" | cut -f2)"
PUBLIC_PACKAGE_DIRS="$(printf '%s\n' "$PUBLIC_PACKAGE_INFO" | cut -f1)"

if [ -z "$PUBLIC_PACKAGE_INFO" ]; then
  release_fail "no public packages were found in the workspace."
fi

release_info ""
release_info "==> Release plan"
release_info "  Remote: $PUBLISH_REMOTE"
release_info "  Current branch: ${CURRENT_BRANCH:-<detached>}"
release_info "  Expected branch: $EXPECTED_RELEASE_BRANCH"
release_info "  Last stable tag: ${LAST_STABLE_TAG:-<none>}"
release_info "  Current stable version: $CURRENT_STABLE_VERSION"
if [ "$canary" = true ]; then
  release_info "  Target stable version: $TARGET_STABLE_VERSION"
  release_info "  Canary version: $TARGET_PUBLISH_VERSION"
  release_info "  Guard: canary is derived from next stable version, not ${CURRENT_STABLE_VERSION}-canary.N"
else
  release_info "  Stable version: $TARGET_STABLE_VERSION"
fi

release_info ""
release_info "==> Step 1/7: Preflight checks..."
release_info "  ✓ Working tree is clean"
release_info "  ✓ Branch matches release train"
require_npm_publish_auth

if [ "$dry_run" = true ] || [ "$canary" = true ]; then
  set_cleanup_trap
fi

release_info ""
release_info "==> Step 2/7: Creating release changeset..."
{
  echo "---"
  while IFS= read -r pkg_name; do
    [ -z "$pkg_name" ] && continue
    echo "\"$pkg_name\": $bump_type"
  done <<< "$PUBLIC_PACKAGE_NAMES"
  echo "---"
  echo ""
  if [ "$canary" = true ]; then
    echo "Canary release preparation for $TARGET_STABLE_VERSION"
  else
    echo "Stable release preparation for $TARGET_STABLE_VERSION"
  fi
} > "$TEMP_CHANGESET_FILE"
release_info "  ✓ Created release changeset for $(printf '%s\n' "$PUBLIC_PACKAGE_NAMES" | sed '/^$/d' | wc -l | xargs) packages"

release_info ""
release_info "==> Step 3/7: Versioning packages..."
cd "$REPO_ROOT"
if [ "$canary" = true ]; then
  npx changeset pre enter canary
fi
npx changeset version

if [ "$canary" = true ]; then
  BASE_CANARY_VERSION="${TARGET_STABLE_VERSION}-canary.0"
  if [ "$TARGET_PUBLISH_VERSION" != "$BASE_CANARY_VERSION" ]; then
    replace_version_string "$BASE_CANARY_VERSION" "$TARGET_PUBLISH_VERSION"
  fi
fi

VERSIONED_PACKAGE_INFO="$(list_public_package_info)"

VERSION_IN_CLI_PACKAGE="$(node -e "console.log(require('$CLI_DIR/package.json').version)")"
if [ "$VERSION_IN_CLI_PACKAGE" != "$TARGET_PUBLISH_VERSION" ]; then
  release_fail "versioning drift detected. Expected $TARGET_PUBLISH_VERSION but found $VERSION_IN_CLI_PACKAGE."
fi
release_info "  ✓ Versioned workspace to $TARGET_PUBLISH_VERSION"

release_info ""
release_info "==> Step 4/7: Building workspace artifacts..."
cd "$REPO_ROOT"
pnpm build
bash "$REPO_ROOT/scripts/prepare-server-ui-dist.sh"
for pkg_dir in server packages/adapters/claude-local packages/adapters/codex-local; do
  rm -rf "$REPO_ROOT/$pkg_dir/skills"
  cp -r "$REPO_ROOT/skills" "$REPO_ROOT/$pkg_dir/skills"
done
release_info "  ✓ Workspace build complete"

release_info ""
release_info "==> Step 5/7: Building publishable CLI bundle..."
"$REPO_ROOT/scripts/build-npm.sh" --skip-checks
release_info "  ✓ CLI bundle ready"

release_info ""
if [ "$dry_run" = true ]; then
  release_info "==> Step 6/7: Previewing publish payloads (--dry-run)..."
  while IFS= read -r pkg_dir; do
    [ -z "$pkg_dir" ] && continue
    release_info "  --- $pkg_dir ---"
    cd "$REPO_ROOT/$pkg_dir"
    npm pack --dry-run 2>&1 | tail -3
  done <<< "$PUBLIC_PACKAGE_DIRS"
  cd "$REPO_ROOT"
  if [ "$canary" = true ]; then
    release_info "  [dry-run] Would publish ${TARGET_PUBLISH_VERSION} under dist-tag canary"
  else
    release_info "  [dry-run] Would publish ${TARGET_PUBLISH_VERSION} under dist-tag latest"
  fi
else
  if [ "$canary" = true ]; then
    release_info "==> Step 6/7: Publishing canary to npm..."
    npx changeset publish
    release_info "  ✓ Published ${TARGET_PUBLISH_VERSION} under dist-tag canary"
  else
    release_info "==> Step 6/7: Publishing stable release to npm..."
    npx changeset publish
    release_info "  ✓ Published ${TARGET_PUBLISH_VERSION} under dist-tag latest"
  fi

  release_info ""
  release_info "==> Post-publish verification: Confirming npm package availability..."
  VERIFY_ATTEMPTS="${NPM_PUBLISH_VERIFY_ATTEMPTS:-12}"
  VERIFY_DELAY_SECONDS="${NPM_PUBLISH_VERIFY_DELAY_SECONDS:-5}"
  MISSING_PUBLISHED_PACKAGES=""
  while IFS=$'\t' read -r pkg_dir pkg_name pkg_version; do
    [ -z "$pkg_name" ] && continue
    release_info "  Checking $pkg_name@$pkg_version"
    if wait_for_npm_package_version "$pkg_name" "$pkg_version" "$VERIFY_ATTEMPTS" "$VERIFY_DELAY_SECONDS"; then
      release_info "    ✓ Found on npm"
      continue
    fi

    if [ -n "$MISSING_PUBLISHED_PACKAGES" ]; then
      MISSING_PUBLISHED_PACKAGES="${MISSING_PUBLISHED_PACKAGES}, "
    fi
    MISSING_PUBLISHED_PACKAGES="${MISSING_PUBLISHED_PACKAGES}${pkg_name}@${pkg_version}"
  done <<< "$VERSIONED_PACKAGE_INFO"

  if [ -n "$MISSING_PUBLISHED_PACKAGES" ]; then
    release_fail "publish completed but npm never exposed: $MISSING_PUBLISHED_PACKAGES. Inspect the changeset publish output before treating this release as good."
  fi

  release_info "  ✓ Verified all versioned packages are available on npm"
fi

release_info ""
if [ "$dry_run" = true ]; then
  release_info "==> Step 7/7: Cleaning up dry-run state..."
  release_info "  ✓ Dry run leaves the working tree unchanged"
elif [ "$canary" = true ]; then
  release_info "==> Step 7/7: Cleaning up canary state..."
  release_info "  ✓ Canary state will be discarded after publish"
else
  release_info "==> Step 7/7: Finalizing stable release commit..."
  restore_publish_artifacts

  git -C "$REPO_ROOT" add -u .changeset packages server cli
  if [ -f "$REPO_ROOT/releases/v${TARGET_STABLE_VERSION}.md" ]; then
    git -C "$REPO_ROOT" add "releases/v${TARGET_STABLE_VERSION}.md"
  fi

  git -C "$REPO_ROOT" commit -m "chore: release v$TARGET_STABLE_VERSION"
  git -C "$REPO_ROOT" tag "v$TARGET_STABLE_VERSION"
  release_info "  ✓ Created commit and tag v$TARGET_STABLE_VERSION"
fi

release_info ""
if [ "$dry_run" = true ]; then
  if [ "$canary" = true ]; then
    release_info "Dry run complete for canary ${TARGET_PUBLISH_VERSION}."
  else
    release_info "Dry run complete for stable v${TARGET_STABLE_VERSION}."
  fi
elif [ "$canary" = true ]; then
  release_info "Published canary ${TARGET_PUBLISH_VERSION}."
  release_info "Install with: npx paperclipai@canary onboard"
  release_info "Stable version remains: $CURRENT_STABLE_VERSION"
else
  release_info "Published stable v${TARGET_STABLE_VERSION}."
  release_info "Next steps:"
  release_info "  git push ${PUBLISH_REMOTE} HEAD --follow-tags"
  release_info "  ./scripts/create-github-release.sh $TARGET_STABLE_VERSION"
  release_info "  Open a PR from ${EXPECTED_RELEASE_BRANCH} to master and merge without squash or rebase"
fi
