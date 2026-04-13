#!/usr/bin/env bash
# paperclip-update — trigger a safe deploy of the Paperclip server.
#
# Designed to run from within a paperclip agent sandbox (inside the server container).
# Calls the dashboard service (http://dashboard:3200) which holds the Docker socket.
# The dashboard runs deploy.sh: build → rolling restart → health check → rollback on failure.
#
# Environment variables:
#   PAPERCLIP_DASHBOARD_URL   Dashboard base URL (default: http://dashboard:3200)
#   PAPERCLIP_DEPLOY_TOKEN    Auth token (default: PAPERCLIP_API_KEY, or empty = no auth)
#   PAPERCLIP_UPDATE_TIMEOUT  Max seconds to wait for deploy (default: 180)
#
# Exit codes:
#   0  Deploy succeeded
#   1  Deploy failed (rollback may have been triggered — server should still be up)
#   2  Usage / connection error

set -euo pipefail

DASHBOARD="${PAPERCLIP_DASHBOARD_URL:-http://dashboard:3200}"
TOKEN="${PAPERCLIP_DEPLOY_TOKEN:-${PAPERCLIP_API_KEY:-}}"
POLL_SEC=3
TIMEOUT="${PAPERCLIP_UPDATE_TIMEOUT:-180}"

# ── helpers ──────────────────────────────────────────────────────────────────

die()  { printf '[paperclip-update] ERROR: %s\n' "$*" >&2; exit 2; }
log()  { printf '[paperclip-update] %s\n' "$*"; }

# Parse a single field from a JSON string using python3 (available in container)
json_field() {
    python3 -c "import sys,json; d=json.loads(sys.argv[2]); v=d.get(sys.argv[1]); print('' if v is None else v)" \
        "$1" "$2" 2>/dev/null || echo ""
}

# ── trigger deploy ────────────────────────────────────────────────────────────

log "Triggering deploy via ${DASHBOARD} ..."

TMPBODY=$(mktemp)
trap 'rm -f "$TMPBODY"' EXIT

HTTP_CODE=$(curl -s --max-time 15 \
    -X POST "${DASHBOARD}/api/deploy" \
    ${TOKEN:+-H "Authorization: Bearer ${TOKEN}"} \
    -H "Content-Type: application/json" \
    -o "$TMPBODY" \
    -w "%{http_code}" 2>/dev/null) || die "Could not reach ${DASHBOARD}/api/deploy — is the dashboard container running?"

RESP=$(cat "$TMPBODY")

case "$HTTP_CODE" in
    202)
        JOB_ID=$(json_field job_id "$RESP")
        [ -z "$JOB_ID" ] && die "No job_id in response: ${RESP}"
        log "Deploy started (job: ${JOB_ID})"
        ;;
    401)
        die "Unauthorized — set PAPERCLIP_DEPLOY_TOKEN to the configured deploy token."
        ;;
    409)
        # Deploy already running — attach to it
        JOB_ID=$(json_field job_id "$RESP")
        [ -z "$JOB_ID" ] && die "Deploy already in progress, but no job_id in response: ${RESP}"
        log "Deploy already in progress — attaching to job ${JOB_ID}."
        ;;
    000)
        die "Connection refused — is the dashboard container running at ${DASHBOARD}?"
        ;;
    *)
        die "Unexpected HTTP ${HTTP_CODE} from dashboard: ${RESP}"
        ;;
esac

# ── poll for completion ───────────────────────────────────────────────────────

echo ""
log "Streaming deploy output (timeout: ${TIMEOUT}s) ..."
echo ""

elapsed=0
last_line_count=0

while [ "$elapsed" -lt "$TIMEOUT" ]; do
    JOB=$(curl -sf --max-time 10 "${DASHBOARD}/api/scripts/jobs/${JOB_ID}" 2>/dev/null) || {
        sleep "$POLL_SEC"
        elapsed=$((elapsed + POLL_SEC))
        continue
    }

    # Print any new output lines
    OUTPUT=$(json_field output "$JOB")
    if [ -n "$OUTPUT" ]; then
        TOTAL=$(printf '%s\n' "$OUTPUT" | wc -l)
        if [ "$TOTAL" -gt "$last_line_count" ]; then
            printf '%s\n' "$OUTPUT" | tail -n +"$((last_line_count + 1))"
            last_line_count=$TOTAL
        fi
    fi

    STATUS=$(json_field status "$JOB")
    case "$STATUS" in
        done)
            echo ""
            log "Deploy SUCCEEDED."
            exit 0
            ;;
        failed|error)
            echo ""
            EXIT_CODE=$(json_field exit_code "$JOB")
            log "Deploy FAILED (exit_code=${EXIT_CODE:-?}) — rollback may have been triggered, server should still be running."
            exit 1
            ;;
        running|"")
            # Still running — keep polling
            ;;
        *)
            log "Unknown status '${STATUS}' — continuing to poll..."
            ;;
    esac

    sleep "$POLL_SEC"
    elapsed=$((elapsed + POLL_SEC))
done

die "Timed out after ${TIMEOUT}s waiting for deploy to complete. Check dashboard at ${DASHBOARD}/api/deploy/status"
