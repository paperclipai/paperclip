#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=./release-lib.sh
. "$REPO_ROOT/scripts/release-lib.sh"
CLI_DIR="$REPO_ROOT/cli"

channel=""
release_date=""
dry_run=false
skip_verify=false
print_version_only=false
tag_name=""

cleanup_on_exit=false

usage() {
  cat <<'EOF'
Usage:
  ./scripts/release.sh <canary|stable> [--date YYYY-MM-DD] [--dry-run] [--skip-verify] [--print-version]

Examples:
  ./scripts/release.sh canary
  ./scripts/release.sh canary --date 2026-03-17 --dry-run
  ./scripts/release.sh stable
  ./scripts/release.sh stable --date 2026-03-17 --dry-run
  ./scripts/release.sh stable --date 2026-03-18 --print-version

Notes:
  - Stable versions use YYYY.MDD.P, where M is the UTC month, DD is the
    zero-padded UTC day, and P is the same-day stable patch slot.
  - Canary releases publish YYYY.MDD.P-canary.N under the npm dist-tag
    "canary" and create the git tag canary/vYYYY.MDD.P-canary.N.
  - Stable releases publish YYYY.MDD.P under the npm dist-tag "latest" and
    create the git tag vYYYY.MDD.P.
  - Stable release notes must already exist at releases/vYYYY.MDD.P.md.
  - The script rewrites versions temporarily and restores the working tree on
    exit. Tags always point at the original source commit, not a generated
    release commit.
EOF
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

set_cleanup_trap() {
  cleanup_on_exit=true
  trap cleanup_release_state EXIT
}

while [ $# -gt 0 ]; do
  case "$1" in
    canary|stable)
      if [ -n "$channel" ]; then
        release_fail "only one release channel may be provided."
      fi
      channel="$1"
      ;;
    --date)
      shift
      [ $# -gt 0 ] || release_fail "--date requires YYYY-MM-DD."
      release_date="$1"
      ;;
    --dry-run) dry_run=true ;;
    --skip-verify) skip_verify=true ;;
    --print-version) print_version_only=true ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      release_fail "unexpected argument: $1"
      ;;
  esac
  shift
done

[ -n "$channel" ] || {
  usage
  exit 1
}

PUBLISH_REMOTE="$(resolve_release_remote)"
fetch_release_remote "$PUBLISH_REMOTE"

CURRENT_BRANCH="$(git_current_branch)"
CURRENT_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
LAST_STABLE_TAG="$(get_last_stable_tag)"
CURRENT_STABLE_VERSION="$(get_current_stable_version)"
RELEASE_DATE="${release_date:-$(utc_date_iso)}"

PUBLIC_PACKAGE_INFO="$(list_public_package_info)"
PUBLIC_PACKAGE_NAMES=()
while IFS= read -r package_name; do
  [ -n "$package_name" ] || continue
  PUBLIC_PACKAGE_NAMES+=("$package_name")
done < <(printf '%s\n' "$PUBLIC_PACKAGE_INFO" | cut -f2)

[ -n "$PUBLIC_PACKAGE_INFO" ] || release_fail "no public packages were found in the workspace."

TARGET_STABLE_VERSION="$(next_stable_version "$RELEASE_DATE" "${PUBLIC_PACKAGE_NAMES[@]}")"
TARGET_PUBLISH_VERSION="$TARGET_STABLE_VERSION"
DIST_TAG="latest"

if [ "$channel" = "canary" ]; then
  require_on_master_branch
  TARGET_PUBLISH_VERSION="$(next_canary_version "$TARGET_STABLE_VERSION" "${PUBLIC_PACKAGE_NAMES[@]}")"
  DIST_TAG="canary"
  tag_name="$(canary_tag_name "$TARGET_PUBLISH_VERSION")"
else
  tag_name="$(stable_tag_name "$TARGET_STABLE_VERSION")"
fi

if [ "$print_version_only" = true ]; then
  printf '%s\n' "$TARGET_PUBLISH_VERSION"
  exit 0
fi

NOTES_FILE="$(release_notes_file "$TARGET_STABLE_VERSION")"

require_clean_worktree
require_npm_publish_auth "$dry_run"

if [ "$channel" = "stable" ] && [ ! -f "$NOTES_FILE" ]; then
  release_fail "stable release notes file is required at $NOTES_FILE before publishing stable."
fi

if [ "$channel" = "canary" ] && [ -f "$NOTES_FILE" ]; then
  release_info "  ✓ Stable release notes already exist at $NOTES_FILE"
fi

if git_local_tag_exists "$tag_name" || git_remote_tag_exists "$tag_name" "$PUBLISH_REMOTE"; then
  release_fail "git tag $tag_name already exists locally or on $PUBLISH_REMOTE."
fi

while IFS= read -r package_name; do
  [ -z "$package_name" ] && continue
  if npm_package_version_exists "$package_name" "$TARGET_PUBLISH_VERSION"; then
    release_fail "npm version ${package_name}@${TARGET_PUBLISH_VERSION} already exists."
  fi
done <<< "$(printf '%s\n' "${PUBLIC_PACKAGE_NAMES[@]}")"

release_info ""
release_info "==> Release plan"
release_info "  Remote: $PUBLISH_REMOTE"
release_info "  Channel: $channel"
release_info "  Current branch: ${CURRENT_BRANCH:-<detached>}"
release_info "  Source commit: $CURRENT_SHA"
release_info "  Last stable tag: ${LAST_STABLE_TAG:-<none>}"
release_info "  Current stable version: $CURRENT_STABLE_VERSION"
release_info "  Release date (UTC): $RELEASE_DATE"
release_info "  Target stable version: $TARGET_STABLE_VERSION"
if [ "$channel" = "canary" ]; then
  release_info "  Canary version: $TARGET_PUBLISH_VERSION"
else
  release_info "  Stable version: $TARGET_PUBLISH_VERSION"
fi
release_info "  Dist-tag: $DIST_TAG"
release_info "  Git tag: $tag_name"
if [ "$channel" = "stable" ]; then
  release_info "  Release notes: $NOTES_FILE"
fi

set_cleanup_trap

if [ "$skip_verify" = false ]; then
  release_info ""
  release_info "==> Step 1/7: Verification gate..."
  cd "$REPO_ROOT"
  pnpm -r typecheck
  pnpm test:run
  pnpm build
else
  release_info ""
  release_info "==> Step 1/7: Verification gate skipped (--skip-verify)"
fi

release_info ""
release_info "==> Step 2/7: Building workspace artifacts..."
cd "$REPO_ROOT"
pnpm build
bash "$REPO_ROOT/scripts/prepare-server-ui-dist.sh"
for pkg_dir in server packages/adapters/claude-local packages/adapters/codex-local; do
  rm -rf "$REPO_ROOT/$pkg_dir/skills"
  cp -r "$REPO_ROOT/skills" "$REPO_ROOT/$pkg_dir/skills"
done
release_info "  ✓ Workspace build complete"

release_info ""
release_info "==> Step 3/7: Rewriting workspace versions..."
set_public_package_version "$TARGET_PUBLISH_VERSION"
release_info "  ✓ Versioned workspace to $TARGET_PUBLISH_VERSION"

release_info ""
release_info "==> Step 4/7: Building publishable CLI bundle..."
"$REPO_ROOT/scripts/build-npm.sh" --skip-checks --skip-typecheck
release_info "  ✓ CLI bundle ready"

VERSIONED_PACKAGE_INFO="$(list_public_package_info)"
VERSION_IN_CLI_PACKAGE="$(node -e "console.log(require('$CLI_DIR/package.json').version)")"
if [ "$VERSION_IN_CLI_PACKAGE" != "$TARGET_PUBLISH_VERSION" ]; then
  release_fail "versioning drift detected. Expected $TARGET_PUBLISH_VERSION but found $VERSION_IN_CLI_PACKAGE."
fi

release_info ""
if [ "$dry_run" = true ]; then
  release_info "==> Step 5/7: Previewing publish payloads (--dry-run)..."
  while IFS=$'\t' read -r pkg_dir _pkg_name _pkg_version; do
    [ -z "$pkg_dir" ] && continue
    release_info "  --- $pkg_dir ---"
    cd "$REPO_ROOT/$pkg_dir"
    pnpm publish --dry-run --no-git-checks --tag "$DIST_TAG" 2>&1 | tail -3
  done <<< "$VERSIONED_PACKAGE_INFO"
  release_info "  [dry-run] Would create git tag $tag_name on $CURRENT_SHA"
else
  release_info "==> Step 5/7: Publishing packages to npm..."
  while IFS=$'\t' read -r pkg_dir pkg_name pkg_version; do
    [ -z "$pkg_dir" ] && continue
    release_info "  Publishing $pkg_name@$pkg_version"
    cd "$REPO_ROOT/$pkg_dir"
    pnpm publish --no-git-checks --tag "$DIST_TAG" --access public
  done <<< "$VERSIONED_PACKAGE_INFO"
  release_info "  ✓ Published all packages under dist-tag $DIST_TAG"
fi

release_info ""
if [ "$dry_run" = true ]; then
  release_info "==> Step 6/7: Skipping npm verification in dry-run mode..."
else
  release_info "==> Step 6/7: Confirming npm package availability..."
  VERIFY_ATTEMPTS="${NPM_PUBLISH_VERIFY_ATTEMPTS:-12}"
  VERIFY_DELAY_SECONDS="${NPM_PUBLISH_VERIFY_DELAY_SECONDS:-5}"
  MISSING_PUBLISHED_PACKAGES=""

  while IFS=$'\t' read -r _pkg_dir pkg_name pkg_version; do
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

  [ -z "$MISSING_PUBLISHED_PACKAGES" ] || release_fail "publish completed but npm never exposed: $MISSING_PUBLISHED_PACKAGES"

  release_info "  ✓ Verified all versioned packages are available on npm"
fi

release_info ""
if [ "$dry_run" = true ]; then
  release_info "==> Step 7/7: Dry run complete..."
else
  release_info "==> Step 7/7: Creating git tag..."
  git -C "$REPO_ROOT" tag "$tag_name" "$CURRENT_SHA"
  release_info "  ✓ Created tag $tag_name on $CURRENT_SHA"
fi

release_info ""
if [ "$dry_run" = true ]; then
  release_info "Dry run complete for $channel ${TARGET_PUBLISH_VERSION}."
else
  if [ "$channel" = "canary" ]; then
    release_info "Published canary ${TARGET_PUBLISH_VERSION}."
    release_info "Install with: npx paperclipai@canary onboard"
    release_info "Next step: git push ${PUBLISH_REMOTE} refs/tags/${tag_name}"
  else
    release_info "Published stable ${TARGET_PUBLISH_VERSION}."
    release_info "Next steps:"
    release_info "  git push ${PUBLISH_REMOTE} refs/tags/${tag_name}"
    release_info "  ./scripts/create-github-release.sh $TARGET_STABLE_VERSION"
  fi
fi
