#!/usr/bin/env bash
# rollback.sh — Roll back paperclip-server to the last known stable image/commit.
# Designed to run inside the dashboard container where:
#   - Docker socket is mounted at /var/run/docker.sock
#   - Project is mounted read-write at /project
#   - paperclip-data volume is mounted at /paperclip-data
#   - Docker CLI and docker compose plugin are available

set -euo pipefail

COMPOSE_FILE="/project/docker/docker-compose.yml"
COMPOSE_DIR="/project/docker"
CONTAINER_NAME="paperclip-server-1"
HEALTH_URL="http://paperclip-server-1:3100/api/health"
STABLE_JSON="/paperclip-data/stable-deploy.json"
MAX_HEALTH_WAIT=90   # seconds
HEALTH_INTERVAL=5    # seconds

log()  { printf '[%s] ROLLBACK %s\n' "$(date -u +%H:%M:%S)" "$*"; }
err()  { printf '[%s] ROLLBACK ERROR: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
sep()  { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$(printf '%.0s─' {1..50})"; }

sep
log "START"
sep

# ── Read stable-deploy.json ──────────────────────────────────────────────────
if [ ! -f "$STABLE_JSON" ]; then
    err "No stable-deploy.json found at $STABLE_JSON — cannot rollback."
    err "A successful deploy must complete before rollback is available."
    exit 1
fi

log "Reading stable deploy info from $STABLE_JSON"
STABLE_COMMIT=$(python3 -c "import json; d=json.load(open('$STABLE_JSON')); print(d['commit'])")
STABLE_TAG=$(python3 -c "import json; d=json.load(open('$STABLE_JSON')); print(d['stable_tag'])")
STABLE_IMAGE_SHA=$(python3 -c "import json; d=json.load(open('$STABLE_JSON')); print(d['image_sha'])")
DEPLOYED_AT=$(python3 -c "import json; d=json.load(open('$STABLE_JSON')); print(d.get('deployed_at','unknown'))")

log "Stable commit:    $STABLE_COMMIT"
log "Stable tag:       $STABLE_TAG"
log "Stable image SHA: ${STABLE_IMAGE_SHA:0:24}..."
log "Originally deployed: $DEPLOYED_AT"

sep

# ── Fast path: image still available ────────────────────────────────────────
if docker image inspect paperclip-server:stable &>/dev/null 2>&1; then
    log "FAST PATH — paperclip-server:stable image found, retagging as latest"
    docker tag paperclip-server:stable paperclip-server:latest
    log "Stopping current server container..."
    docker compose -f "$COMPOSE_FILE" -p paperclip stop server 2>/dev/null || true
    log "Starting server with stable image..."
    docker compose -f "$COMPOSE_FILE" -p paperclip up -d --no-deps server
else
    # ── Slow path: image was pruned — checkout commit and rebuild ────────────
    log "SLOW PATH — paperclip-server:stable image not found (may have been pruned)"
    log "Checking out stable commit $STABLE_COMMIT in /project..."

    if ! git -C /project checkout "$STABLE_COMMIT" 2>&1; then
        err "git checkout $STABLE_COMMIT failed — manual recovery required."
        exit 1
    fi
    log "Checked out $STABLE_COMMIT — rebuilding..."

    if ! docker compose -f "$COMPOSE_FILE" -p paperclip build server 2>&1; then
        err "Build failed during slow-path rollback."
        exit 1
    fi
    log "Build complete. Starting server..."
    docker compose -f "$COMPOSE_FILE" -p paperclip up -d --no-deps server
fi

sep
log "HEALTH CHECK (${MAX_HEALTH_WAIT}s window)"
sep

elapsed=0
healthy=false

while [ $elapsed -lt $MAX_HEALTH_WAIT ]; do
    STATUS=$(docker inspect "$CONTAINER_NAME" --format '{{.State.Status}}' 2>/dev/null || echo "unknown")
    log "t+${elapsed}s — container: $STATUS"

    if [ "$STATUS" = "exited" ] || [ "$STATUS" = "dead" ]; then
        err "Container exited unexpectedly during rollback health check."
        EXIT_CODE=$(docker inspect "$CONTAINER_NAME" --format '{{.State.ExitCode}}' 2>/dev/null || echo "?")
        err "Exit code: $EXIT_CODE"
        log "Last 30 lines of container log:"
        docker logs "$CONTAINER_NAME" --tail 30 2>&1 || true
        exit 1
    fi

    if [ "$STATUS" = "running" ]; then
        if curl -sf --max-time 3 "$HEALTH_URL" -o /dev/null 2>/dev/null; then
            log "HTTP health check passed at $HEALTH_URL"
            healthy=true
            break
        fi
        log "Container running — waiting for HTTP readiness..."
    fi

    sleep $HEALTH_INTERVAL
    elapsed=$((elapsed + HEALTH_INTERVAL))
done

if [ "$healthy" = false ]; then
    FINAL_STATUS=$(docker inspect "$CONTAINER_NAME" --format '{{.State.Status}}' 2>/dev/null || echo "unknown")
    if [ "$FINAL_STATUS" = "running" ]; then
        log "Container is running (health endpoint did not respond but container is up)."
        log "Rollback treated as successful — verify manually if needed."
    else
        err "Health check timed out after ${MAX_HEALTH_WAIT}s — container status: $FINAL_STATUS"
        exit 1
    fi
fi

sep
log "ROLLBACK COMPLETE — server is running stable commit $STABLE_COMMIT"
sep
exit 0
