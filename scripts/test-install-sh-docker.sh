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
    scripts/install.sh scripts/test-install-sh-docker.sh scripts/install-sh-fixtures/npx
}

run_with_node() {
  local name="$1"
  shift
  docker run --rm \
    -v "$REPO_ROOT/scripts:/paperclip-scripts:ro" \
    -v "$RESULTS_DIR:/results" \
    -e "PAPERCLIP_INSTALL_TEST_LOG=/results/$name.args" \
    -e PATH="/paperclip-scripts/install-sh-fixtures:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    node:22-bookworm-slim \
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

echo "==> shellcheck"
run_shellcheck

echo "==> existing Node"
run_with_node with-node bash /paperclip-scripts/install.sh --no-prompt --no-onboard
assert_line "$RESULTS_DIR/with-node.args" "paperclipai@latest"
assert_line "$RESULTS_DIR/with-node.args" "install"
assert_line "$RESULTS_DIR/with-node.args" "--yes"
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
  node:22-bookworm-slim \
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
  echo "Expected --ref failure before invoking npx" >&2
  exit 1
}

echo "==> piped mode requires explicit consent"
if run_with_node piped-rejected bash -c 'cat /paperclip-scripts/install.sh | bash -s -- --no-onboard'; then
  echo "Expected piped install without --no-prompt to fail" >&2
  exit 1
fi

echo "==> piped --no-prompt"
run_with_node piped bash -c 'cat /paperclip-scripts/install.sh | bash -s -- --no-prompt --no-onboard'
assert_line "$RESULTS_DIR/piped.args" "--yes"

echo "==> dry run"
run_with_node dry-run bash /paperclip-scripts/install.sh --no-prompt --dry-run --no-onboard
[ ! -e "$RESULTS_DIR/dry-run.args" ] || {
  echo "Expected --dry-run to avoid invoking npx" >&2
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
  node:22-bookworm-slim \
  bash /paperclip-scripts/install.sh
assert_line "$RESULTS_DIR/env.args" "paperclipai@2026.722.0"
assert_line "$RESULTS_DIR/env.args" "--version"
assert_line "$RESULTS_DIR/env.args" "2026.722.0"
assert_no_line "$RESULTS_DIR/env.args" "--repo"
assert_no_line "$RESULTS_DIR/env.args" "--install-service"
assert_line "$RESULTS_DIR/env.args" "service"

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
[ "$node_major" -ge 20 ] || {
  printf 'Expected Node >= 20, got %s\n' "$node_version" >&2
  exit 1
}

echo "Installer Docker checks passed."
