#!/usr/bin/env bash
# deploy-local.sh — Rebuild and restart the Paperclip server Docker container
# with the latest code from the current git state (typically master).
#
# Usage (run from repo root or from host with Docker access):
#   ./scripts/deploy-local.sh
#   ./scripts/deploy-local.sh --no-pull          # skip git pull
#   ./scripts/deploy-local.sh --dry-run          # print steps without executing
#
# Prerequisites:
#   - Docker and docker compose (v2) available
#   - docker-compose.yml is at ./docker/docker-compose.yml
#   - Run from the repo root (or set REPO_ROOT)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker/docker-compose.yml"

dry_run=false
skip_pull=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)   dry_run=true  ; shift ;;
    --no-pull)   skip_pull=true ; shift ;;
    -h|--help)
      sed -n '/^# /s/^# //p' "$0" | head -12
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

run() {
  if [ "$dry_run" = true ]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

echo "==> Paperclip local deploy"
echo "    repo: $REPO_ROOT"
echo "    compose: $COMPOSE_FILE"

# Step 1: pull latest master (optional)
if [ "$skip_pull" = false ]; then
  echo "==> Pulling latest master..."
  run git -C "$REPO_ROOT" fetch origin master
  run git -C "$REPO_ROOT" merge --ff-only origin/master
fi

# Step 2: rebuild only the server image (no-cache ensures code changes are picked up)
echo "==> Building server image..."
run docker compose -f "$COMPOSE_FILE" build --no-cache server

# Step 3: restart the server container with the new image
echo "==> Restarting server container..."
run docker compose -f "$COMPOSE_FILE" up -d --no-deps server

# Step 4: wait for healthcheck
if [ "$dry_run" = false ]; then
  echo "==> Waiting for server to become healthy..."
  TIMEOUT=120
  ELAPSED=0
  API_URL="${PAPERCLIP_API_URL:-http://localhost:3100}"
  until curl -sf "$API_URL/api/health" >/dev/null 2>&1; do
    if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
      echo "ERROR: server did not become healthy within ${TIMEOUT}s" >&2
      exit 1
    fi
    sleep 3
    ELAPSED=$((ELAPSED + 3))
    printf "  ... %ds elapsed\n" "$ELAPSED"
  done
  echo "==> Server is healthy at $API_URL"
fi

echo "==> Deploy complete."
echo ""
echo "Next: run kpi-monitor to compare token metrics before/after:"
echo "  node scripts/kpi-monitor.mjs"
