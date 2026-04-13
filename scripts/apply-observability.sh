#!/usr/bin/env bash
set -euo pipefail

# Apply observability fixes: restart server + Homer, verify /metrics.
# Runs from inside the dashboard container via docker socket.
#
# Default behavior avoids long rebuilds that can exceed dashboard script timeouts.
# Set APPLY_OBSERVABILITY_BUILD=1 to force a rebuild of the server image.

COMPOSE_PROJECT="/project"
BUILD_MODE="${APPLY_OBSERVABILITY_BUILD:-0}"
PROJECT_NAME="${PAPERCLIP_COMPOSE_PROJECT_NAME:-paperclip}"
COMPOSE=(
  docker compose
  --project-name "$PROJECT_NAME"
  --env-file "$COMPOSE_PROJECT/.env"
  -f "$COMPOSE_PROJECT/docker/docker-compose.yml"
  -f "$COMPOSE_PROJECT/docker-compose.observability.yml"
)

if [[ "$BUILD_MODE" == "1" ]]; then
  echo "==> Rebuilding and restarting server + homer (project=$PROJECT_NAME, APPLY_OBSERVABILITY_BUILD=1)..."
  "${COMPOSE[@]}" up -d --build server homer
else
  echo "==> Restarting server + homer (project=$PROJECT_NAME, fast mode, no build)..."
  "${COMPOSE[@]}" up -d server homer
  "${COMPOSE[@]}" restart server homer
fi

echo "==> Waiting for server startup..."
for _ in {1..15}; do
  if curl -sf http://server:3100/api/health >/dev/null 2>&1 || curl -sf http://localhost:3100/api/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo "==> Testing /metrics endpoint..."
if curl -sf http://server:3100/metrics 2>/dev/null | head -5 || curl -sf http://localhost:3100/metrics 2>/dev/null | head -5; then
  echo ""
  echo "==> /metrics is responding with Prometheus format"
else
  echo "==> WARNING: /metrics not yet available (server may still be starting)"
fi

echo "==> Done."
