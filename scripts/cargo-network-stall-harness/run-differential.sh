#!/usr/bin/env bash
# Reproduce the CI network stall on purpose, then prove the new cargo
# config survives it.
#
# The script builds one synthetic crate and serves it from a local HTTP
# server. The server holds the download body empty for a fixed stall
# period, then sends it in full. Two arms fetch that crate:
#
#   Arm A (the control) forces the old cargo defaults with environment
#   variables. The fetch must fail with the exact error text seen in CI.
#
#   Arm B uses the repository's own .cargo/config.toml, found by cargo's
#   normal upward directory search from the repository root. The same
#   stall must not fail the fetch.
#
# Run this script from anywhere; it resolves paths from its own location.
set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HARNESS_DIR/../.." && pwd)"
STALL_SECONDS="${STALL_SECONDS:-40}"
CRATE_NAME="stallharnesscrate"
CRATE_VERSION="0.1.0"
SCRATCH="$HARNESS_DIR/.scratch"

export PATH="$HOME/.cargo/bin:$PATH"

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is not on PATH; cannot run the stall differential" >&2
  exit 1
fi

rm -rf "$SCRATCH"
mkdir -p "$SCRATCH/crate-src/${CRATE_NAME}-${CRATE_VERSION}/src"

cat > "$SCRATCH/crate-src/${CRATE_NAME}-${CRATE_VERSION}/Cargo.toml" <<EOF
[package]
name = "${CRATE_NAME}"
version = "${CRATE_VERSION}"
edition = "2021"
EOF
: > "$SCRATCH/crate-src/${CRATE_NAME}-${CRATE_VERSION}/src/lib.rs"

TARBALL="$SCRATCH/${CRATE_NAME}-${CRATE_VERSION}.crate"
tar --sort=name --owner=0 --group=0 --numeric-owner \
  -czf "$TARBALL" -C "$SCRATCH/crate-src" "${CRATE_NAME}-${CRATE_VERSION}"
CKSUM="$(sha256sum "$TARBALL" | awk '{print $1}')"

mkdir -p "$SCRATCH/consumer/src"
cat > "$SCRATCH/consumer/Cargo.toml" <<EOF
[package]
name = "stall-harness-consumer"
version = "0.0.0"
edition = "2021"
publish = false

[dependencies]
${CRATE_NAME} = { version = "${CRATE_VERSION}", registry = "stall-harness" }
EOF
echo "fn main() {}" > "$SCRATCH/consumer/src/main.rs"

node "$HARNESS_DIR/stall-server.mjs" \
  --port 0 \
  --crate-name "$CRATE_NAME" \
  --crate-version "$CRATE_VERSION" \
  --cksum "$CKSUM" \
  --stall-seconds "$STALL_SECONDS" \
  --tarball "$TARBALL" \
  > "$SCRATCH/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  if grep -q "^LISTENING " "$SCRATCH/server.log" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
PORT="$(grep "^LISTENING " "$SCRATCH/server.log" | awk '{print $2}')"
if [ -z "$PORT" ]; then
  echo "stall server did not report a port" >&2
  cat "$SCRATCH/server.log" >&2
  exit 1
fi
echo "stall server listening on 127.0.0.1:$PORT (stall period ${STALL_SECONDS}s)"

export CARGO_REGISTRIES_STALL_HARNESS_INDEX="sparse+http://127.0.0.1:${PORT}/index/"

run_arm() {
  local label="$1"
  shift
  rm -rf "$SCRATCH/cargo-home" "$SCRATCH/consumer/Cargo.lock"
  mkdir -p "$SCRATCH/cargo-home"
  echo "--- Arm $label ---"
  (
    cd "$REPO_ROOT"
    CARGO_HOME="$SCRATCH/cargo-home" "$@" cargo fetch --manifest-path "$SCRATCH/consumer/Cargo.toml"
  )
}

set +e
ARM_A_OUTPUT="$(run_arm A env CARGO_NET_RETRY=3 CARGO_HTTP_TIMEOUT=30 2>&1)"
ARM_A_STATUS=$?
set -e
echo "$ARM_A_OUTPUT"
echo "Arm A exit status: $ARM_A_STATUS"

set +e
ARM_B_OUTPUT="$(run_arm B env -u CARGO_NET_RETRY -u CARGO_HTTP_TIMEOUT 2>&1)"
ARM_B_STATUS=$?
set -e
echo "$ARM_B_OUTPUT"
echo "Arm B exit status: $ARM_B_STATUS"

echo "--- verdict ---"
FAIL=0

if [ "$ARM_A_STATUS" -eq 0 ]; then
  echo "FAIL: Arm A (old defaults) was expected to fail but the fetch succeeded"
  FAIL=1
elif ! grep -q "transfer too slow: failed to transfer more than 10 bytes in 30s" <<<"$ARM_A_OUTPUT"; then
  echo "FAIL: Arm A did not report the expected stall error text"
  FAIL=1
else
  echo "PASS: Arm A failed with the expected stall error text"
fi

if [ "$ARM_B_STATUS" -ne 0 ]; then
  echo "FAIL: Arm B (new config) was expected to succeed but the fetch failed"
  FAIL=1
else
  echo "PASS: Arm B succeeded through the same stall"
fi

exit $FAIL
