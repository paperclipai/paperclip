#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'verify:rootless supports Debian and Ubuntu Linux hosts only.\n' >&2
  exit 1
fi

for required_command in apt-cache apt-get dpkg dpkg-deb; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    printf 'verify:rootless requires %s (Debian/Ubuntu package tooling).\n' "$required_command" >&2
    exit 1
  fi
done

rootless_cache_base="${PAPERCLIP_RUNNER_BROWSER_DEPS_DIR:-${PAPERCLIP_RUN_SCRATCH_DIR:-${XDG_CACHE_HOME:-${HOME:?HOME is not set}/.cache}/paperclip-runner/playwright-libs}}"
debian_architecture="$(dpkg --print-architecture)"
rootless_deps_dir="$rootless_cache_base/$debian_architecture"
rootless_marker="$rootless_deps_dir/.complete-v2"

select_available_package() {
  local candidate
  for candidate in "$@"; do
    if apt-cache show "$candidate" >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  printf 'No supported package candidate found for: %s\n' "$*" >&2
  return 1
}

if [[ ! -f "$rootless_marker" ]]; then
  browser_packages=(
    "$(select_available_package libatk1.0-0t64 libatk1.0-0)"
    "$(select_available_package libatspi2.0-0t64 libatspi2.0-0)"
    "$(select_available_package libxcomposite1)"
    "$(select_available_package libxdamage1)"
    "$(select_available_package libxfixes3)"
    "$(select_available_package libxi6)"
    "$(select_available_package libxrandr2)"
    "$(select_available_package libxrender1)"
    "$(select_available_package libgbm1)"
    "$(select_available_package libasound2t64 libasound2)"
  )
  download_dir="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-runner-browser-deps.XXXXXX")"
  trap 'rm -rf "$download_dir"' EXIT
  mkdir -p "$rootless_deps_dir"

  (
    cd "$download_dir"
    apt-get download "${browser_packages[@]}"
  )

  shopt -s nullglob
  downloaded_packages=("$download_dir"/*.deb)
  if [[ ${#downloaded_packages[@]} -ne ${#browser_packages[@]} ]]; then
    printf 'Expected %s browser-library packages, downloaded %s.\n' \
      "${#browser_packages[@]}" "${#downloaded_packages[@]}" >&2
    exit 1
  fi
  for package_archive in "${downloaded_packages[@]}"; do
    # Host applications can inject unrelated runtime libraries (for example an
    # embedded database's liblzma). System package tooling must use system libs.
    env -u LD_LIBRARY_PATH dpkg-deb --extract "$package_archive" "$rootless_deps_dir"
  done
  touch "$rootless_marker"
fi

case "$debian_architecture" in
  amd64) library_triplet="x86_64-linux-gnu" ;;
  arm64) library_triplet="aarch64-linux-gnu" ;;
  *)
    printf 'verify:rootless does not yet map Debian architecture %s.\n' "$debian_architecture" >&2
    exit 1
    ;;
esac

rootless_library_path="$rootless_deps_dir/usr/lib/$library_triplet:$rootless_deps_dir/lib/$library_triplet:$rootless_deps_dir/usr/lib"
printf 'Running verification with rootless browser libraries from %s.\n' "$rootless_deps_dir"
if [[ $# -gt 0 ]]; then
  LD_LIBRARY_PATH="$rootless_library_path${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" "$@"
else
  LD_LIBRARY_PATH="$rootless_library_path${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" pnpm run verify
fi
