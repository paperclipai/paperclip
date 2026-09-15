#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RESULTS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-install-sh.XXXXXX")"
KEEP_RESULTS="${KEEP_RESULTS:-0}"

cleanup() {
  if [ "$KEEP_RESULTS" = "1" ]; then
    printf 'Kept installer test results at %s\n' "$RESULTS_DIR"
    return
  fi
  rm -rf "$RESULTS_DIR"
}

trap cleanup EXIT

command -v docker >/dev/null 2>&1 || {
  echo "docker is required" >&2
  exit 1
}

run_shellcheck() {
  docker run --rm \
    -v "$REPO_ROOT:/work:ro" \
    -w /work \
    koalaman/shellcheck:stable \
    scripts/install.sh scripts/test-install-sh-docker.sh scripts/install-sh-fixtures/npx scripts/install-sh-fixtures/npm
}

run_with_node() {
  local name="$1"
  shift
  docker run --rm \
    -v "$REPO_ROOT/scripts:/paperclip-scripts:ro" \
    -v "$RESULTS_DIR:/results" \
    -e "PAPERCLIP_INSTALL_TEST_LOG=/results/$name.args" \
    -e PATH="/paperclip-scripts/install-sh-fixtures:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    node:24-bookworm-slim \
    "$@"
}

assert_line() {
  local file="$1"
  local expected="$2"
  grep -Fx -- "$expected" "$file" >/dev/null || {
    printf 'Expected %q in %s\n' "$expected" "$file" >&2
    cat "$file" >&2
    exit 1
  }
}

assert_no_line() {
  local file="$1"
  local unexpected="$2"
  if grep -Fx -- "$unexpected" "$file" >/dev/null; then
    printf 'Did not expect %q in %s\n' "$unexpected" "$file" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_contains() {
  local file="$1"
  local needle="$2"
  grep -qF -- "$needle" "$file" >/dev/null || {
    printf 'Expected to find %q in %s\n' "$needle" "$file" >&2
    cat "$file" >&2
    exit 1
  }
}

echo "==> shellcheck"
run_shellcheck

echo "==> existing Node"
run_with_node with-node bash /paperclip-scripts/install.sh --no-prompt --no-onboard
assert_line "$RESULTS_DIR/with-node.args" "paperclipai@latest"
assert_line "$RESULTS_DIR/with-node.args" "install"
assert_line "$RESULTS_DIR/with-node.args" "-g"
assert_line "$RESULTS_DIR/with-node.args" "--prefix"
assert_line "$RESULTS_DIR/with-node.args" "--registry=https://registry.npmjs.org"
assert_line "$RESULTS_DIR/with-node.args" "NPM_CONFIG_REGISTRY=https://registry.npmjs.org"
assert_line "$RESULTS_DIR/with-node.args" "npm_config_registry=https://registry.npmjs.org"
assert_line "$RESULTS_DIR/with-node.args" "npmrc:registry=https://registry.npmjs.org"

echo "==> hostile npm config isolation"
mkdir -p "$RESULTS_DIR/hostile-home"
printf 'registry=http://attacker-registry.invalid\n' >"$RESULTS_DIR/hostile-home/.npmrc"
docker run --rm \
  -v "$REPO_ROOT/scripts:/paperclip-scripts:ro" \
  -v "$RESULTS_DIR:/results" \
  -e HOME=/results/hostile-home \
  -e NPM_CONFIG_REGISTRY=http://attacker-registry.invalid \
  -e npm_config_registry=http://attacker-registry.invalid \
  -e PAPERCLIP_INSTALL_TEST_LOG=/results/hostile.args \
  -e PATH="/paperclip-scripts/install-sh-fixtures:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  node:24-bookworm-slim \
  bash /paperclip-scripts/install.sh --no-prompt --no-onboard
assert_line "$RESULTS_DIR/hostile.args" "--registry=https://registry.npmjs.org"
assert_line "$RESULTS_DIR/hostile.args" "NPM_CONFIG_REGISTRY=https://registry.npmjs.org"
assert_line "$RESULTS_DIR/hostile.args" "npm_config_registry=https://registry.npmjs.org"
assert_line "$RESULTS_DIR/hostile.args" "npmrc:registry=https://registry.npmjs.org"

echo "==> --ref master"
if run_with_node ref-master bash /paperclip-scripts/install.sh --ref master --no-onboard; then
  echo "Expected --ref to fail until git-ref installation support is integrated" >&2
  exit 1
fi
[ ! -e "$RESULTS_DIR/ref-master.args" ] || {
  echo "Expected --ref failure before invoking npm" >&2
  exit 1
}

echo "==> piped mode requires explicit consent"
if run_with_node piped-rejected bash -c 'cat /paperclip-scripts/install.sh | bash -s -- --no-onboard'; then
  echo "Expected piped install without --no-prompt to fail" >&2
  exit 1
fi

echo "==> piped --no-prompt"
run_with_node piped bash -c 'cat /paperclip-scripts/install.sh | bash -s -- --no-prompt --no-onboard'
assert_line "$RESULTS_DIR/piped.args" "install"

echo "==> piped mode refuses privileged Node bootstrap"
if docker run --rm \
  -v "$REPO_ROOT/scripts:/paperclip-scripts:ro" \
  -e PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  ubuntu:24.04 \
  bash -c 'cat /paperclip-scripts/install.sh | bash -s -- --no-prompt --no-onboard' \
  >"$RESULTS_DIR/piped-no-node.out" 2>&1; then
  echo "Expected piped install without Node.js to fail before privileged bootstrap" >&2
  exit 1
fi
assert_line "$RESULTS_DIR/piped-no-node.out" "[paperclip] error: Node.js bootstrap is disabled for piped installs; download install.sh, review it, and run 'bash install.sh --no-prompt'"

echo "==> dry run"
run_with_node dry-run bash /paperclip-scripts/install.sh --no-prompt --dry-run --no-onboard
[ ! -e "$RESULTS_DIR/dry-run.args" ] || {
  echo "Expected --dry-run to avoid invoking npm" >&2
  exit 1
}

echo "==> environment twins"
docker run --rm \
  -v "$REPO_ROOT/scripts:/paperclip-scripts:ro" \
  -v "$RESULTS_DIR:/results" \
  -e PAPERCLIP_INSTALL_TEST_LOG=/results/env.args \
  -e PAPERCLIP_INSTALL_VERSION=2026.722.0 \
  -e PAPERCLIP_INSTALL_INSTALL_SERVICE=1 \
  -e PAPERCLIP_INSTALL_NO_ONBOARD=1 \
  -e PAPERCLIP_INSTALL_NO_PROMPT=1 \
  -e PATH="/paperclip-scripts/install-sh-fixtures:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  node:24-bookworm-slim \
  bash /paperclip-scripts/install.sh
assert_line "$RESULTS_DIR/env.args" "paperclipai@2026.722.0"
assert_no_line "$RESULTS_DIR/env.args" "--repo"
assert_no_line "$RESULTS_DIR/env.args" "--install-service"

echo "==> no Node, apt bootstrap"
docker run --rm \
  -v "$REPO_ROOT/scripts:/paperclip-scripts:ro" \
  -v "$RESULTS_DIR:/results" \
  -e PAPERCLIP_INSTALL_TEST_LOG=/results/no-node.args \
  -e PATH="/paperclip-scripts/install-sh-fixtures:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  ubuntu:24.04 \
  bash -c 'apt-get update >/dev/null && apt-get install -y ca-certificates curl >/dev/null && bash /paperclip-scripts/install.sh --no-prompt --no-onboard'
assert_line "$RESULTS_DIR/no-node.args" "paperclipai@latest"
node_version="$(cat "$RESULTS_DIR/no-node.args.node")"
node_major="${node_version#v}"
node_major="${node_major%%.*}"
[ "$node_major" -ge 24 ] || {
  printf 'Expected Node >= 24, got %s\n' "$node_version" >&2
  exit 1
}

echo "==> update_path: empty home creates .profile for login shells"
mkdir -p "$RESULTS_DIR/path-empty-home"
docker run --rm \
  -v "$REPO_ROOT/scripts:/paperclip-scripts:ro" \
  -v "$RESULTS_DIR:/results" \
  -e HOME=/results/path-empty-home \
  -e PAPERCLIP_INSTALL_TEST_LOG=/results/path-empty.args \
  -e PATH="/paperclip-scripts/install-sh-fixtures:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  node:22-bookworm-slim \
  bash /paperclip-scripts/install.sh --no-prompt --no-onboard
[ -f "$RESULTS_DIR/path-empty-home/.profile" ] || {
  echo "Expected .profile created for fresh login shells" >&2
  exit 1
}
assert_contains "$RESULTS_DIR/path-empty-home/.profile" 'export PATH="/results/path-empty-home/.local/bin:'

echo "==> update_path: bashrc-only home still creates a login file"
mkdir -p "$RESULTS_DIR/path-bashrc-home"
printf 'alias ll=ls\n' >"$RESULTS_DIR/path-bashrc-home/.bashrc"
docker run --rm \
  -v "$REPO_ROOT/scripts:/paperclip-scripts:ro" \
  -v "$RESULTS_DIR:/results" \
  -e HOME=/results/path-bashrc-home \
  -e PAPERCLIP_INSTALL_TEST_LOG=/results/path-bashrc.args \
  -e PATH="/paperclip-scripts/install-sh-fixtures:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  node:22-bookworm-slim \
  bash /paperclip-scripts/install.sh --no-prompt --no-onboard
assert_contains "$RESULTS_DIR/path-bashrc-home/.bashrc" 'export PATH="/results/path-bashrc-home/.local/bin:'
[ -f "$RESULTS_DIR/path-bashrc-home/.profile" ] || {
  echo "Expected a login startup file (.profile) alongside .bashrc" >&2
  exit 1
}
assert_contains "$RESULTS_DIR/path-bashrc-home/.profile" 'export PATH="/results/path-bashrc-home/.local/bin:'

echo "==> update_path: zsh home (no rc files) creates .zshrc, not .profile"
mkdir -p "$RESULTS_DIR/path-zsh-home"
docker run --rm \
  -v "$REPO_ROOT/scripts:/paperclip-scripts:ro" \
  -v "$RESULTS_DIR:/results" \
  -e HOME=/results/path-zsh-home \
  -e SHELL=/bin/zsh \
  -e PAPERCLIP_INSTALL_TEST_LOG=/results/path-zsh.args \
  -e PATH="/paperclip-scripts/install-sh-fixtures:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  node:22-bookworm-slim \
  bash /paperclip-scripts/install.sh --no-prompt --no-onboard
[ -f "$RESULTS_DIR/path-zsh-home/.zshrc" ] || {
  echo "Expected .zshrc created for a zsh login shell" >&2
  exit 1
}
assert_contains "$RESULTS_DIR/path-zsh-home/.zshrc" 'export PATH="/results/path-zsh-home/.local/bin:'
[ ! -e "$RESULTS_DIR/path-zsh-home/.profile" ] || {
  echo "Did not expect .profile for a zsh user" >&2
  exit 1
}

echo "==> update_path: zsh home with only .zprofile still creates .zshrc"
mkdir -p "$RESULTS_DIR/path-zprof-home"
printf 'umask 022\n' >"$RESULTS_DIR/path-zprof-home/.zprofile"
docker run --rm \
  -v "$REPO_ROOT/scripts:/paperclip-scripts:ro" \
  -v "$RESULTS_DIR:/results" \
  -e HOME=/results/path-zprof-home \
  -e SHELL=/bin/zsh \
  -e PAPERCLIP_INSTALL_TEST_LOG=/results/path-zprof.args \
  -e PATH="/paperclip-scripts/install-sh-fixtures:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  node:22-bookworm-slim \
  bash /paperclip-scripts/install.sh --no-prompt --no-onboard
# .zprofile is login-only; interactive non-login zsh reads .zshrc, so .zshrc
# must be created even though .zprofile already exists and was patched.
[ -f "$RESULTS_DIR/path-zprof-home/.zshrc" ] || {
  echo "Expected .zshrc created alongside an existing .zprofile" >&2
  exit 1
}
assert_contains "$RESULTS_DIR/path-zprof-home/.zshrc" 'export PATH="/results/path-zprof-home/.local/bin:'
assert_contains "$RESULTS_DIR/path-zprof-home/.zprofile" 'export PATH="/results/path-zprof-home/.local/bin:'

echo "==> update_path: bash home with only .bash_profile still creates .bashrc"
mkdir -p "$RESULTS_DIR/path-bashprof-home"
printf 'umask 022\n' >"$RESULTS_DIR/path-bashprof-home/.bash_profile"
docker run --rm \
  -v "$REPO_ROOT/scripts:/paperclip-scripts:ro" \
  -v "$RESULTS_DIR:/results" \
  -e HOME=/results/path-bashprof-home \
  -e SHELL=/bin/bash \
  -e PAPERCLIP_INSTALL_TEST_LOG=/results/path-bashprof.args \
  -e PATH="/paperclip-scripts/install-sh-fixtures:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  node:22-bookworm-slim \
  bash /paperclip-scripts/install.sh --no-prompt --no-onboard
# .bash_profile is login-only; non-login interactive bash reads .bashrc, so
# .bashrc must be created even though the login class is already covered.
[ -f "$RESULTS_DIR/path-bashprof-home/.bashrc" ] || {
  echo "Expected .bashrc created alongside an existing .bash_profile" >&2
  exit 1
}
assert_contains "$RESULTS_DIR/path-bashprof-home/.bashrc" 'export PATH="/results/path-bashprof-home/.local/bin:'
assert_contains "$RESULTS_DIR/path-bashprof-home/.bash_profile" 'export PATH="/results/path-bashprof-home/.local/bin:'
# .bash_profile already covers login shells, so no redundant .profile.
[ ! -e "$RESULTS_DIR/path-bashprof-home/.profile" ] || {
  echo "Did not expect .profile when .bash_profile already exists" >&2
  exit 1
}

echo "==> update_path: PATH already exported in this process still persists"
mkdir -p "$RESULTS_DIR/path-transient-home"
printf 'alias ll=ls\n' >"$RESULTS_DIR/path-transient-home/.bashrc"
docker run --rm \
  -v "$REPO_ROOT/scripts:/paperclip-scripts:ro" \
  -v "$RESULTS_DIR:/results" \
  -e HOME=/results/path-transient-home \
  -e SHELL=/bin/bash \
  -e PAPERCLIP_INSTALL_TEST_LOG=/results/path-transient.args \
  -e PATH="/results/path-transient-home/.local/bin:/paperclip-scripts/install-sh-fixtures:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  node:22-bookworm-slim \
  bash /paperclip-scripts/install.sh --no-prompt --no-onboard
# The installer process inherited ~/.local/bin on PATH, but the startup files
# never had it. Skipping persistence here would break the next fresh shell.
assert_contains "$RESULTS_DIR/path-transient-home/.bashrc" 'export PATH="/results/path-transient-home/.local/bin:'
[ -f "$RESULTS_DIR/path-transient-home/.profile" ] || {
  echo "Expected a login startup file despite ~/.local/bin already being on PATH" >&2
  exit 1
}
assert_contains "$RESULTS_DIR/path-transient-home/.profile" 'export PATH="/results/path-transient-home/.local/bin:'

echo "==> update_path: existing export is not duplicated"
mkdir -p "$RESULTS_DIR/path-idem-home"
# Seed both classes so a re-install has nothing left to do: persistence now runs
# on every install, so a fully covered home must come out byte-identical.
for idem_rc in .profile .bashrc; do
  # shellcheck disable=SC2016  # seed the exact export line install.sh would write
  printf 'export PATH="/results/path-idem-home/.local/bin:$PATH"\n' >"$RESULTS_DIR/path-idem-home/$idem_rc"
done
idem_before="$(cat "$RESULTS_DIR/path-idem-home/.profile" "$RESULTS_DIR/path-idem-home/.bashrc")"
docker run --rm \
  -v "$REPO_ROOT/scripts:/paperclip-scripts:ro" \
  -v "$RESULTS_DIR:/results" \
  -e HOME=/results/path-idem-home \
  -e SHELL=/bin/bash \
  -e PAPERCLIP_INSTALL_TEST_LOG=/results/path-idem.args \
  -e PATH="/paperclip-scripts/install-sh-fixtures:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  node:22-bookworm-slim \
  bash /paperclip-scripts/install.sh --no-prompt --no-onboard
idem_after="$(cat "$RESULTS_DIR/path-idem-home/.profile" "$RESULTS_DIR/path-idem-home/.bashrc")"
[ "$idem_after" = "$idem_before" ] || {
  printf 'Expected startup files to be unchanged, got:\n%s\n---\n%s\n' "$idem_before" "$idem_after" >&2
  exit 1
}

echo "Installer Docker checks passed."
