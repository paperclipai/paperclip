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
CLI_DIR="$REPO_ROOT/cli"
TEMP_CHANGESET_FILE="$REPO_ROOT/.changeset/release-bump.md"
TEMP_PRE_FILE="$REPO_ROOT/.changeset/pre.json"
PUBLISH_REMOTE="${PUBLISH_REMOTE:-public-gh}"

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

info() {
  echo "$@"
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

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

require_clean_worktree() {
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
    fail "working tree is not clean. Commit, stash, or remove changes before releasing."
  fi
}

require_npm_publish_auth() {
  if [ "$dry_run" = true ]; then
    return
  fi

  if npm whoami >/dev/null 2>&1; then
    info "  ✓ Logged in to npm as $(npm whoami)"
    return
  fi

  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    info "  ✓ npm publish auth will be provided by GitHub Actions trusted publishing"
    return
  fi

  fail "npm publish auth is not available. Use 'npm login' locally or run from the GitHub release workflow."
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
  const key = `${dir}\t${name}`;
  if (seen.has(key)) continue;
  seen.add(key);
  process.stdout.write(`${dir}\t${name}\n`);
}
NODE
}

compute_bumped_version() {
  node - "$1" "$2" <<'NODE'
const current = process.argv[2];
const bump = process.argv[3];
const match = current.match(/^(\d+)\.(\d+)\.(\d+)$/);

if (!match) {
  throw new Error(`invalid semver version: ${current}`);
}

let [major, minor, patch] = match.slice(1).map(Number);

if (bump === 'patch') {
  patch += 1;
} else if (bump === 'minor') {
  minor += 1;
  patch = 0;
} else if (bump === 'major') {
  major += 1;
  minor = 0;
  patch = 0;
} else {
  throw new Error(`unsupported bump type: ${bump}`);
}

process.stdout.write(`${major}.${minor}.${patch}`);
NODE
}

next_canary_version() {
  local stable_version="$1"
  local versions_json

  versions_json="$(npm view paperclipai versions --json 2>/dev/null || echo '[]')"

  node - "$stable_version" "$versions_json" <<'NODE'
const stable = process.argv[2];
const versionsArg = process.argv[3];

let versions = [];
try {
  const parsed = JSON.parse(versionsArg);
  versions = Array.isArray(parsed) ? parsed : [parsed];
} catch {
  versions = [];
}

const pattern = new RegExp(`^${stable.replace(/\./g, '\\.')}-canary\\.(\\d+)$`);
let max = -1;

for (const version of versions) {
  const match = version.match(pattern);
  if (!match) continue;
  max = Math.max(max, Number(match[1]));
}

process.stdout.write(`${stable}-canary.${max + 1}`);
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

LAST_STABLE_TAG="$(git -C "$REPO_ROOT" tag --list 'v*' --sort=-version:refname | head -1)"
CURRENT_STABLE_VERSION="${LAST_STABLE_TAG#v}"
if [ -z "$CURRENT_STABLE_VERSION" ]; then
  CURRENT_STABLE_VERSION="0.0.0"
fi

TARGET_STABLE_VERSION="$(compute_bumped_version "$CURRENT_STABLE_VERSION" "$bump_type")"
TARGET_PUBLISH_VERSION="$TARGET_STABLE_VERSION"

if [ "$canary" = true ]; then
  TARGET_PUBLISH_VERSION="$(next_canary_version "$TARGET_STABLE_VERSION")"
fi

if [ "$TARGET_STABLE_VERSION" = "$CURRENT_STABLE_VERSION" ]; then
  fail "next stable version matches the current stable version. Refusing to publish."
fi

if [[ "$TARGET_PUBLISH_VERSION" == "${CURRENT_STABLE_VERSION}-canary."* ]]; then
  fail "canary versions must be derived from the next stable version, never ${CURRENT_STABLE_VERSION}-canary.N."
fi

PUBLIC_PACKAGE_INFO="$(list_public_package_info)"
PUBLIC_PACKAGE_NAMES="$(printf '%s\n' "$PUBLIC_PACKAGE_INFO" | cut -f2)"
PUBLIC_PACKAGE_DIRS="$(printf '%s\n' "$PUBLIC_PACKAGE_INFO" | cut -f1)"

if [ -z "$PUBLIC_PACKAGE_INFO" ]; then
  fail "no public packages were found in the workspace."
fi

info ""
info "==> Release plan"
info "  Last stable tag: ${LAST_STABLE_TAG:-<none>}"
info "  Current stable version: $CURRENT_STABLE_VERSION"
if [ "$canary" = true ]; then
  info "  Target stable version: $TARGET_STABLE_VERSION"
  info "  Canary version: $TARGET_PUBLISH_VERSION"
  info "  Guard: canary is derived from next stable version, not ${CURRENT_STABLE_VERSION}-canary.N"
else
  info "  Stable version: $TARGET_STABLE_VERSION"
fi

info ""
info "==> Step 1/7: Preflight checks..."
require_clean_worktree
info "  ✓ Working tree is clean"
require_npm_publish_auth

if [ "$dry_run" = true ] || [ "$canary" = true ]; then
  set_cleanup_trap
fi

info ""
info "==> Step 2/7: Creating release changeset..."
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
info "  ✓ Created release changeset for $(printf '%s\n' "$PUBLIC_PACKAGE_NAMES" | sed '/^$/d' | wc -l | xargs) packages"

info ""
info "==> Step 3/7: Versioning packages..."
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

VERSION_IN_CLI_PACKAGE="$(node -e "console.log(require('$CLI_DIR/package.json').version)")"
if [ "$VERSION_IN_CLI_PACKAGE" != "$TARGET_PUBLISH_VERSION" ]; then
  fail "versioning drift detected. Expected $TARGET_PUBLISH_VERSION but found $VERSION_IN_CLI_PACKAGE."
fi
info "  ✓ Versioned workspace to $TARGET_PUBLISH_VERSION"

info ""
info "==> Step 4/7: Building workspace artifacts..."
cd "$REPO_ROOT"
pnpm build
bash "$REPO_ROOT/scripts/prepare-server-ui-dist.sh"
for pkg_dir in server packages/adapters/claude-local packages/adapters/codex-local; do
  rm -rf "$REPO_ROOT/$pkg_dir/skills"
  cp -r "$REPO_ROOT/skills" "$REPO_ROOT/$pkg_dir/skills"
done
info "  ✓ Workspace build complete"

info ""
info "==> Step 5/7: Building publishable CLI bundle..."
"$REPO_ROOT/scripts/build-npm.sh" --skip-checks
info "  ✓ CLI bundle ready"

info ""
if [ "$dry_run" = true ]; then
  info "==> Step 6/7: Previewing publish payloads (--dry-run)..."
  while IFS= read -r pkg_dir; do
    [ -z "$pkg_dir" ] && continue
    info "  --- $pkg_dir ---"
    cd "$REPO_ROOT/$pkg_dir"
    npm pack --dry-run 2>&1 | tail -3
  done <<< "$PUBLIC_PACKAGE_DIRS"
  cd "$REPO_ROOT"
  if [ "$canary" = true ]; then
    info "  [dry-run] Would publish ${TARGET_PUBLISH_VERSION} under dist-tag canary"
  else
    info "  [dry-run] Would publish ${TARGET_PUBLISH_VERSION} under dist-tag latest"
  fi
else
  if [ "$canary" = true ]; then
    info "==> Step 6/7: Publishing canary to npm..."
    npx changeset publish
    info "  ✓ Published ${TARGET_PUBLISH_VERSION} under dist-tag canary"
  else
    info "==> Step 6/7: Publishing stable release to npm..."
    npx changeset publish
    info "  ✓ Published ${TARGET_PUBLISH_VERSION} under dist-tag latest"
  fi
fi

info ""
if [ "$dry_run" = true ]; then
  info "==> Step 7/7: Cleaning up dry-run state..."
  info "  ✓ Dry run leaves the working tree unchanged"
elif [ "$canary" = true ]; then
  info "==> Step 7/7: Cleaning up canary state..."
  info "  ✓ Canary state will be discarded after publish"
else
  info "==> Step 7/7: Finalizing stable release commit..."
  restore_publish_artifacts

  git -C "$REPO_ROOT" add -u .changeset packages server cli
  if [ -f "$REPO_ROOT/releases/v${TARGET_STABLE_VERSION}.md" ]; then
    git -C "$REPO_ROOT" add "releases/v${TARGET_STABLE_VERSION}.md"
  fi

  git -C "$REPO_ROOT" commit -m "chore: release v$TARGET_STABLE_VERSION"
  git -C "$REPO_ROOT" tag "v$TARGET_STABLE_VERSION"
  info "  ✓ Created commit and tag v$TARGET_STABLE_VERSION"
fi

info ""
if [ "$dry_run" = true ]; then
  if [ "$canary" = true ]; then
    info "Dry run complete for canary ${TARGET_PUBLISH_VERSION}."
  else
    info "Dry run complete for stable v${TARGET_STABLE_VERSION}."
  fi
elif [ "$canary" = true ]; then
  info "Published canary ${TARGET_PUBLISH_VERSION}."
  info "Install with: npx paperclipai@canary onboard"
  info "Stable version remains: $CURRENT_STABLE_VERSION"
else
  info "Published stable v${TARGET_STABLE_VERSION}."
  info "Next steps:"
  info "  git push ${PUBLISH_REMOTE} HEAD:master --follow-tags"
  info "  ./scripts/create-github-release.sh $TARGET_STABLE_VERSION"
fi
