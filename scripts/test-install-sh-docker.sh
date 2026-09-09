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
    node:24-bookworm-slim \
    "$@"
}

BASH32_IMAGE="paperclip-install-sh-bash32"

run_with_bash32() {
  local name="$1"
  shift
  docker run --rm \
    -v "$REPO_ROOT/scripts:/paperclip-scripts:ro" \
    -v "$RESULTS_DIR:/results" \
    -e "PAPERCLIP_INSTALL_TEST_LOG=/results/$name.args" \
    -e PATH="/paperclip-scripts/install-sh-fixtures:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "$BASH32_IMAGE" \
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
  node:24-bookworm-slim \
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
[ "$node_major" -ge 24 ] || {
  printf 'Expected Node >= 24, got %s\n' "$node_version" >&2
  exit 1
}

# macOS ships bash 3.2.57 as /bin/bash and the documented one-liner runs the
# installer under it, so a bash 4+ construct is a total install failure on every
# stock Mac. `bash -n` does not catch it: `${value,,}` parses fine and only
# explodes when expanded. (2026-09-09: the published installer carried
# `${value,,}` in parse_bool, which runs before any real work, so
# `curl … | bash` could not install Paperclip on any Mac.)
echo "==> bash 3.2 image"
docker build \
  --file "$REPO_ROOT/scripts/install-sh-bash32.Dockerfile" \
  --tag "$BASH32_IMAGE" \
  "$REPO_ROOT/scripts"

echo "==> bash 3.2 is really 3.2"
# shellcheck disable=SC2016 # must expand in the container's bash, not this one
run_with_bash32 bash32-version bash32 -c 'echo "$BASH_VERSION"' >"$RESULTS_DIR/bash32.version"
grep -q '^3\.2\.' "$RESULTS_DIR/bash32.version" || {
  printf 'Expected bash 3.2 in this lane, got %s\n' "$(cat "$RESULTS_DIR/bash32.version")" >&2
  exit 1
}

# If this ever succeeds, the lane is running a newer bash and every assertion
# below has quietly stopped testing anything. Match the error text rather than
# just a non-zero exit: docker failing to start (125) or a missing binary (127)
# would also "fail" here without proving the shell rejected the expansion.
echo "==> bash 4 expansions fail under this shell"
# shellcheck disable=SC2016 # the bash 4 expansion is the payload, not a bug
if run_with_bash32 bash32-canary bash32 -c 'value=ABC; printf "%s" "${value,,}"' \
  >"$RESULTS_DIR/bash32-canary.out" 2>&1; then
  echo "Expected \${value,,} to be a bad substitution under bash 3.2" >&2
  cat "$RESULTS_DIR/bash32-canary.out" >&2
  exit 1
fi
grep -qi 'bad substitution' "$RESULTS_DIR/bash32-canary.out" || {
  echo "Canary failed, but not with 'bad substitution' — the lane may be broken rather than proving anything" >&2
  cat "$RESULTS_DIR/bash32-canary.out" >&2
  exit 1
}

echo "==> installer runs end-to-end under bash 3.2"
run_with_bash32 bash32-install bash32 /paperclip-scripts/install.sh --no-prompt --no-onboard
assert_line "$RESULTS_DIR/bash32-install.args" "paperclipai@latest"
assert_line "$RESULTS_DIR/bash32-install.args" "install"
assert_line "$RESULTS_DIR/bash32-install.args" "--yes"

# parse_bool lowercases its input; under bash 3.2 that has to happen without
# ${value,,}, and only a non-lowercase value proves the replacement works.
echo "==> bash 3.2 parses uppercase boolean env twins"
docker run --rm \
  -v "$REPO_ROOT/scripts:/paperclip-scripts:ro" \
  -v "$RESULTS_DIR:/results" \
  -e PAPERCLIP_INSTALL_TEST_LOG=/results/bash32-env.args \
  -e PAPERCLIP_INSTALL_NO_PROMPT=TRUE \
  -e PAPERCLIP_INSTALL_NO_ONBOARD=Yes \
  -e PAPERCLIP_INSTALL_CANARY=Off \
  -e PATH="/paperclip-scripts/install-sh-fixtures:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  "$BASH32_IMAGE" \
  bash32 /paperclip-scripts/install.sh
assert_line "$RESULTS_DIR/bash32-env.args" "paperclipai@latest"
assert_line "$RESULTS_DIR/bash32-env.args" "--yes"

echo "Installer Docker checks passed."
