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

echo "==> shellcheck"
run_shellcheck

echo "==> existing Node"
run_with_node with-node bash /paperclip-scripts/install.sh --no-onboard
assert_line "$RESULTS_DIR/with-node.args" "paperclipai@latest"
assert_line "$RESULTS_DIR/with-node.args" "install"
assert_line "$RESULTS_DIR/with-node.args" "--no-prompt"

echo "==> --ref master"
run_with_node ref-master bash /paperclip-scripts/install.sh --ref master --no-onboard
assert_line "$RESULTS_DIR/ref-master.args" "--ref"
assert_line "$RESULTS_DIR/ref-master.args" "master"

echo "==> piped --no-prompt"
run_with_node piped bash -c 'cat /paperclip-scripts/install.sh | bash -s -- --no-prompt --no-onboard'
assert_line "$RESULTS_DIR/piped.args" "--no-prompt"

echo "==> environment twins"
docker run --rm \
  -v "$REPO_ROOT/scripts:/paperclip-scripts:ro" \
  -v "$RESULTS_DIR:/results" \
  -e PAPERCLIP_INSTALL_TEST_LOG=/results/env.args \
  -e PAPERCLIP_INSTALL_VERSION=2026.722.0 \
  -e PAPERCLIP_INSTALL_REPO=example/paperclip \
  -e PAPERCLIP_INSTALL_INSTALL_SERVICE=1 \
  -e PAPERCLIP_INSTALL_NO_ONBOARD=1 \
  -e PATH="/paperclip-scripts/install-sh-fixtures:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  node:22-bookworm-slim \
  bash /paperclip-scripts/install.sh
assert_line "$RESULTS_DIR/env.args" "paperclipai@2026.722.0"
assert_line "$RESULTS_DIR/env.args" "--version"
assert_line "$RESULTS_DIR/env.args" "2026.722.0"
assert_line "$RESULTS_DIR/env.args" "--repo"
assert_line "$RESULTS_DIR/env.args" "example/paperclip"
assert_line "$RESULTS_DIR/env.args" "--install-service"

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
