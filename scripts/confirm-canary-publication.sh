#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=./release-lib.sh
. "$REPO_ROOT/scripts/release-lib.sh"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/confirm-canary-publication.sh <canary-version> <source-sha>

Confirms a canary that ./scripts/release.sh canary --defer-registry-confirmation
published, then creates and pushes its canary/v<version> tag at <source-sha>.
Run it from a checkout of <source-sha>. It waits for every public package
version to become registry-visible, requires npm provenance from the master
release workflow at <source-sha>, checks dist-tags and internal dependencies
(the canary dist-tag may already name a newer canary), and installs the exact
version into a clean prefix. A tag that already points at <source-sha> is
accepted, so a rerun is safe.
EOF
}

[ $# -eq 2 ] || { usage; exit 1; }
version="$1"
source_sha="$2"

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-canary\.[0-9]+$ ]] || release_fail "not a canary version: $version"
[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || release_fail "not a full commit SHA: $source_sha"
[ "$(git -C "$REPO_ROOT" rev-parse HEAD)" = "$source_sha" ] || release_fail "checkout is not $source_sha"
require_canary_number_from_master_commit "$version" "$source_sha"

tag_name="$(canary_tag_name "$version")"
PUBLISH_REMOTE="$(resolve_release_remote)"

PACKAGE_INFO=""
PACKAGE_NAMES=()
while IFS=$'\t' read -r pkg_dir pkg_name _pkg_version; do
  [ -n "$pkg_name" ] || continue
  PACKAGE_NAMES+=("$pkg_name")
  PACKAGE_INFO+="${pkg_dir}"$'\t'"${pkg_name}"$'\t'"${version}"$'\n'
done < <(list_public_package_info)
[ "${#PACKAGE_NAMES[@]}" -gt 0 ] || release_fail "no public packages were found in the workspace."

release_info "==> Waiting for registry visibility of ${#PACKAGE_NAMES[@]} packages at ${version}..."
wait_for_npm_package_versions "${NPM_PUBLISH_VERIFY_ATTEMPTS:-12}" "${NPM_PUBLISH_VERIFY_DELAY_SECONDS:-5}" "$PACKAGE_INFO" \
  || release_fail "npm did not expose every package at ${version}"

release_info "==> Checking npm provenance..."
node "$REPO_ROOT/scripts/verify-canary-provenance.mjs" "$version" "$source_sha" "${PACKAGE_NAMES[@]}" \
  || release_fail "npm provenance does not tie ${version} to the master release workflow at ${source_sha}"

release_info "==> Checking dist-tags and internal dependencies..."
verify_args=(--channel canary --dist-tag canary --target-version "$version" --allow-newer-canary)
for pkg_name in "${PACKAGE_NAMES[@]}"; do verify_args+=(--package "$pkg_name"); done
if wait_for_release_registry_state "${NPM_REGISTRY_STATE_VERIFY_ATTEMPTS:-12}" "${NPM_REGISTRY_STATE_VERIFY_DELAY_SECONDS:-5}" "${verify_args[@]}"; then
  :
else
  release_fail "npm dist-tags or registry metadata are wrong or never converged for ${version}"
fi

release_info "==> Installing paperclipai@${version} into a clean prefix..."
wait_for_npm_installable "paperclipai@${version}" "$version" "${NPM_INSTALL_VERIFY_TIMEOUT_SECONDS:-1200}" "${NPM_INSTALL_VERIFY_DELAY_SECONDS:-30}" \
  || release_fail "paperclipai@${version} did not install cleanly"

push_release_tag_at "$PUBLISH_REMOTE" "$tag_name" "$source_sha"
