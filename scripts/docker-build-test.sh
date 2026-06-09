#!/usr/bin/env bash
# Verify the Docker image builds successfully.
# Skips gracefully when docker/podman is not available.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Detect container runtime
if command -v docker >/dev/null 2>&1; then
  RUNTIME=docker
elif command -v podman >/dev/null 2>&1; then
  RUNTIME=podman
else
  echo "SKIP: neither docker nor podman found — skipping build test"
  exit 0
fi

# Verify the daemon is reachable (docker may be installed but not running)
if ! "$RUNTIME" info >/dev/null 2>&1; then
  echo "SKIP: $RUNTIME is installed but not running — skipping build test"
  exit 0
fi

IMAGE_TAG="paperclip-build-test:$$"
trap '"$RUNTIME" rmi "$IMAGE_TAG" >/dev/null 2>&1 || true' EXIT

echo "==> Testing Docker build with $RUNTIME"
"$RUNTIME" build \
  -f "$REPO_ROOT/Dockerfile" \
  -t "$IMAGE_TAG" \
  --target production \
  "$REPO_ROOT"

echo "==> Verifying key binaries in image"
"$RUNTIME" run --rm "$IMAGE_TAG" sh -c '
  set -e
  node --version
  git --version
  gh --version
  rg --version
  python3 --version
  curl --version | head -1
  claude --version 2>/dev/null || echo "claude CLI not found (OK in minimal builds)"
'

echo "PASS: Docker build test succeeded"
