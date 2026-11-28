#!/usr/bin/env bash
# Pre-warm the local Docker daemon with the most recent published master
# image's layers while Buildx builds and pushes, so the post-push PID 1
# orphan-reaping probe (`docker run --pull always`) only downloads and
# extracts the small changed top layers.
set -euo pipefail

is_docker_pid() {
  local pid="$1"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  local args
  args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  printf '%s\n' "$args" | grep -Eq '(^|[[:space:]/])docker[[:space:]]+pull([[:space:]]|$)'
}

case "${1:-}" in
  start)
    : "${IMAGE_NAME:?IMAGE_NAME is required}"
    : "${PLATFORM:?PLATFORM is required}"
    : "${PID_FILE:?PID_FILE is required}"
    : "${LOG_FILE:?LOG_FILE is required}"
    ref=""
    for depth in 1 2 3 4 5 6 7 8 9 10; do
      sha="$(git rev-parse --verify "HEAD~${depth}^{commit}" 2>/dev/null || true)"
      [ -n "$sha" ] || break
      if docker manifest inspect "$IMAGE_NAME:sha-$sha" >/dev/null 2>&1; then
        ref="$IMAGE_NAME:sha-$sha"
        break
      fi
    done
    if [ -z "$ref" ]; then
      echo "No recent published master image found in the last 10 commits; skipping base-layer pre-warm."
      exit 0
    fi
    echo "Pre-warming $PLATFORM base layers in background from $ref"
    nohup docker pull --quiet --platform "$PLATFORM" "$ref" >"$LOG_FILE" 2>&1 </dev/null &
    echo "$!" > "$PID_FILE"
    ;;
  stop)
    : "${PID_FILE:?PID_FILE is required}"
    wait_seconds="${2:-0}"
    [[ "$wait_seconds" =~ ^[0-9]+$ ]] || { echo "Invalid wait_seconds: $wait_seconds" >&2; exit 2; }
    if [ -f "$PID_FILE" ]; then
      pid="$(cat "$PID_FILE" 2>/dev/null || true)"
      if is_docker_pid "$pid"; then
        if [ "$wait_seconds" -gt 0 ]; then
          echo "Waiting up to ${wait_seconds}s for background base-layer pre-warm (pid $pid)..."
          elapsed=0
          while [ "$elapsed" -lt "$wait_seconds" ] && is_docker_pid "$pid"; do
            sleep 1
            elapsed=$((elapsed + 1))
          done
        fi
        if is_docker_pid "$pid"; then
          echo "Stopping still-running base-layer pre-warm (pid $pid)."
          kill "$pid" 2>/dev/null || true
        fi
      fi
      rm -f "$PID_FILE"
    fi
    ;;
  *)
    echo "Usage: $0 start | stop [wait_seconds]" >&2
    exit 2
    ;;
esac
