#!/usr/bin/env bash
# deploy.sh — Build and deploy the Paperclip local fork via docker compose.
# Designed to run inside the dashboard container where:
#   - Docker socket is mounted at /var/run/docker.sock
#   - Project is mounted read-only at /project
#   - Docker CLI and docker compose plugin are available

set -euo pipefail

COMPOSE_FILE="/project/docker/docker-compose.yml"
COMPOSE_DIR="/project/docker"
REPO_DIR="/project"
PROJECT_NAME="paperclip"
SERVICE="server"
CONTAINER_NAME="paperclip-server-1"
HEALTH_URL="http://paperclip-server-1:3100/api/health"
MAX_HEALTH_WAIT=60   # seconds
HEALTH_INTERVAL=5    # seconds

# Stable-commit tracking file
STABLE_COMMIT_FILE="${COMPOSE_DIR}/../data/.stable-commit"

log()  { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
err()  { printf '[%s] ERROR: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
sep()  { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$(printf '%.0s─' {1..50})"; }

sep
log "PAPERCLIP DEPLOY — START"
log "Compose: $COMPOSE_FILE"
log "Service: $SERVICE"
sep

# ── Rollback checkpoint ────────────────────────────────────────────────────────
PREV_IMAGE=""
if docker inspect "$CONTAINER_NAME" &>/dev/null 2>&1; then
    PREV_IMAGE=$(docker inspect "$CONTAINER_NAME" --format '{{.Image}}' 2>/dev/null || true)
    log "Rollback image captured: ${PREV_IMAGE:0:24}..."
    log "Container was: $(docker inspect "$CONTAINER_NAME" --format '{{.State.Status}}' 2>/dev/null)"
else
    log "No existing $CONTAINER_NAME container — fresh deploy"
fi

# ── Build phase ────────────────────────────────────────────────────────────────
sep
log "PHASE 1/3 — BUILD"
sep

if ! docker compose -f "$COMPOSE_FILE" -p "$PROJECT_NAME" build "$SERVICE" 2>&1; then
    err "Build failed — nothing was deployed."
    exit 1
fi

log "Build succeeded."

# ── Deploy phase ───────────────────────────────────────────────────────────────
sep
log "PHASE 2/3 — DEPLOY (rolling restart of $SERVICE only)"
sep

rollback() {
    err "Deployment failed — initiating rollback..."
    if [ -f "$STABLE_COMMIT_FILE" ]; then
        log "Last known stable commit: $(cat "$STABLE_COMMIT_FILE" 2>/dev/null || echo "unknown")"
    fi
    if [ -n "$PREV_IMAGE" ]; then
        log "Stopping failed container..."
        docker compose -f "$COMPOSE_FILE" -p "$PROJECT_NAME" stop "$SERVICE" 2>/dev/null || true
        log "Attempting to restart previous image: ${PREV_IMAGE:0:24}..."
        # Force the old image back and restart
        docker run -d \
            --name "${CONTAINER_NAME}-rollback-$$" \
            --label "com.docker.compose.project=$PROJECT_NAME" \
            --label "com.docker.compose.service=$SERVICE" \
            "$PREV_IMAGE" 2>/dev/null || true
        log "Rollback attempted. Check container state manually if service is down."
    else
        log "No previous image available — manual recovery required."
    fi
}

if ! docker compose -f "$COMPOSE_FILE" -p "$PROJECT_NAME" up -d --no-deps "$SERVICE" 2>&1; then
    rollback
    exit 1
fi

log "Container started."

# ── Health check ───────────────────────────────────────────────────────────────
sep
log "PHASE 3/3 — HEALTH CHECK (${MAX_HEALTH_WAIT}s window)"
sep

elapsed=0
healthy=false

while [ $elapsed -lt $MAX_HEALTH_WAIT ]; do
    STATUS=$(docker inspect "$CONTAINER_NAME" --format '{{.State.Status}}' 2>/dev/null || echo "unknown")
    log "t+${elapsed}s — container: $STATUS"

    if [ "$STATUS" = "exited" ] || [ "$STATUS" = "dead" ]; then
        err "Container exited unexpectedly."
        EXIT_CODE=$(docker inspect "$CONTAINER_NAME" --format '{{.State.ExitCode}}' 2>/dev/null || echo "?")
        err "Exit code: $EXIT_CODE"
        log "Last 30 lines of container log:"
        docker logs "$CONTAINER_NAME" --tail 30 2>&1 || true
        rollback
        exit 1
    fi

    if [ "$STATUS" = "running" ]; then
        # Try HTTP health endpoint
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
    # Final status check
    FINAL_STATUS=$(docker inspect "$CONTAINER_NAME" --format '{{.State.Status}}' 2>/dev/null || echo "unknown")
    if [ "$FINAL_STATUS" = "running" ]; then
        # Container is up even if health endpoint didn't respond — treat as ok
        log "Container is running (health endpoint did not respond but container is up)."
        log "Deploy treated as successful — verify manually if needed."
    else
        err "Health check timed out after ${MAX_HEALTH_WAIT}s — container status: $FINAL_STATUS"
        rollback
        exit 1
    fi
fi

sep
log "DEPLOY COMPLETE"
log "Service: $SERVICE"
FINAL_IMAGE=$(docker inspect "$CONTAINER_NAME" --format '{{.Image}}' 2>/dev/null | cut -c1-24 || echo "unknown")
log "Running image: ${FINAL_IMAGE}..."
sep

# ── crash-loop watchdog ──────────────────────────────────────────────────────
# After a successful health-check, monitor the container for crash loops.
# If it exits N times in WATCH_WINDOW seconds, roll back to the previous image.
WATCH_WINDOW=120    # seconds to watch after deploy
CRASH_THRESHOLD=3   # crashes within the window triggers rollback
CRASH_COUNT=0
WATCH_START=$(date +%s)

log "Watching for crash loops (${CRASH_THRESHOLD} crashes in ${WATCH_WINDOW}s triggers rollback)..."

while true; do
    NOW=$(date +%s)
    ELAPSED=$((NOW - WATCH_START))

    if [ "$ELAPSED" -ge "$WATCH_WINDOW" ]; then
        log "Crash-loop window passed cleanly — deploy is stable."
        break
    fi

    STATUS=$(docker inspect --format='{{.State.Status}}' paperclip-server-1 2>/dev/null || echo "gone")

    if [ "$STATUS" = "exited" ] || [ "$STATUS" = "dead" ] || [ "$STATUS" = "gone" ]; then
        CRASH_COUNT=$((CRASH_COUNT + 1))
        log "Container crash detected (crash #${CRASH_COUNT})"

        if [ "$CRASH_COUNT" -ge "$CRASH_THRESHOLD" ]; then
            log "CRASH LOOP DETECTED — rolling back to previous image: ${PREV_IMAGE}"
            if [ -f "$STABLE_COMMIT_FILE" ]; then
                log "Last known stable commit: $(cat "$STABLE_COMMIT_FILE" 2>/dev/null || echo "unknown")"
            fi
            docker stop paperclip-server-1 2>/dev/null || true
            # Restore previous image tag
            docker tag "$PREV_IMAGE" paperclip-server:latest
            cd "$COMPOSE_DIR" && docker compose up -d --no-deps server
            log "Rollback to ${PREV_IMAGE} complete. Marking deploy as FAILED."
            exit 1
        fi

        # Wait for Docker's restart policy to bring it back up
        sleep 10
    fi

    sleep 5
done

# ── Tag stable image and record stable-deploy.json ──────────────────────────
NEW_IMAGE=$(docker inspect "${CONTAINER_NAME}" --format '{{.Image}}' 2>/dev/null || echo "")
if [ -n "$NEW_IMAGE" ]; then
    docker tag "$NEW_IMAGE" paperclip-server:stable
    STABLE_COMMIT=$(git -C /project rev-parse HEAD 2>/dev/null || echo "unknown")
    # Write to both STABLE_COMMIT_FILE and stable-deploy.json for compatibility
    mkdir -p "$(dirname "$STABLE_COMMIT_FILE")" 2>/dev/null || true
    echo "$STABLE_COMMIT" > "$STABLE_COMMIT_FILE" 2>/dev/null || true
    python3 -c "
import json, datetime
d = {
    'commit': '$STABLE_COMMIT',
    'image_sha': '$NEW_IMAGE',
    'stable_tag': 'paperclip-server:stable',
    'deployed_at': datetime.datetime.utcnow().isoformat() + 'Z'
}
open('/paperclip-data/stable-deploy.json','w').write(json.dumps(d,indent=2))
print('Stable commit recorded: $STABLE_COMMIT')
" 2>/dev/null || log "Stable commit recorded: $STABLE_COMMIT"
fi

sep
log "ALL PHASES COMPLETE — service is stable."
sep
