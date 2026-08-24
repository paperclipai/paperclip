#!/bin/bash
# voyonder.com uptime monitor — runs every minute via cron
# Checks /api/health/live and logs failures, alerts only on transition to failure
#
# Auto-recovery (VOY-1481): on a second consecutive failure, runs the travel_app
# recovery script (/opt/travel_planner/scripts/recover-travel-app.sh) to clear
# zombie docker-proxy port binds and restart the container.  Recovery is
# attempted AT MOST once per failure cycle (no thrashing).
#
# SAFETY: flock-based lock to prevent concurrent instances (cron runs every minute
# but recovery may take longer than 60s).
#
# Install: copy to /opt/scripts/ on vps-1 and add root cron job:
#   * * * * * /opt/scripts/voyonder-uptime.sh
#
set -euo pipefail

LOCK_FILE="/var/run/voyonder-uptime.lock"

# --- flock-based lock (atomic; no TOCTOU race) ------------------------------
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[voyonder-uptime] $(date -u +'%Y-%m-%dT%H:%M:%SZ') another instance is already running — exiting"
  exit 0
fi
# Lock released automatically when script exits (fd 9 closes)

URL="https://voyonder.com/api/health/live"
STATE_FILE="/var/run/voyonder-uptime-state"
LOG_FILE="/var/log/voyonder-uptime.log"
RECOVERY_SCRIPT="/opt/travel_planner/scripts/recover-travel-app.sh"
RECOVERY_STATE_FILE="${STATE_FILE}.recovery"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

HTTP_CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$URL" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
    # Site is up — log success only if previous state was down
    if [ -f "$STATE_FILE" ]; then
        PREV=$(cat "$STATE_FILE")
        if [ "$PREV" != "up" ]; then
            echo "[$NOW] RECOVERED — $URL returned $HTTP_CODE (was $PREV)" >> "$LOG_FILE"
        fi
    fi
    echo "up" > "$STATE_FILE"
    rm -f "$RECOVERY_STATE_FILE" 2>/dev/null || true
    exit 0
fi

# Site is down — log failure
echo "[$NOW] FAILURE — $URL returned $HTTP_CODE" >> "$LOG_FILE"
PREV="up"
[ -f "$STATE_FILE" ] && PREV=$(cat "$STATE_FILE")
echo "down" > "$STATE_FILE"

# Auto-recovery on the SECOND consecutive failure (gives one minute for
# transient blips to self-heal before we touch anything).  The recovery
# state file acts as a latch: recovery runs at most once per down-cycle.
if [ "$PREV" = "down" ] && [ ! -f "$RECOVERY_STATE_FILE" ]; then
    echo "[$NOW] Second consecutive failure — invoking travel_app recovery" >> "$LOG_FILE"
    if [ -x "$RECOVERY_SCRIPT" ]; then
        if "$RECOVERY_SCRIPT" >> "$LOG_FILE" 2>&1; then
            echo "[$NOW] RECOVERY OK — travel_app healthy after auto-recovery" >> "$LOG_FILE"
            echo "up" > "$STATE_FILE"
            exit 0
        else
            echo "[$NOW] RECOVERY FAILED — manual intervention required" >> "$LOG_FILE"
        fi
    else
        echo "[$NOW] RECOVERY SCRIPT MISSING at $RECOVERY_SCRIPT" >> "$LOG_FILE"
    fi
    touch "$RECOVERY_STATE_FILE"
fi

exit 1