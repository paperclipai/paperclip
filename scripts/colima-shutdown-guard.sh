#!/bin/bash
# Colima graceful shutdown guard
# Runs as a macOS LaunchDaemon — traps SIGTERM (sent on Mac shutdown/reboot)
# and runs "colima stop" so Postgres can flush WAL before the VM dies.
#
# INSTALL (one-time, needs sudo):
#   sudo mkdir -p /usr/local/bin
#   sudo cp scripts/colima-shutdown-guard.sh /usr/local/bin/colima-shutdown-guard.sh
#   sudo xattr -c /usr/local/bin/colima-shutdown-guard.sh
#   sudo cp scripts/com.colima.graceful-shutdown.plist /Library/LaunchDaemons/
#   sudo chmod 644 /Library/LaunchDaemons/com.colima.graceful-shutdown.plist
#   sudo chown root:wheel /Library/LaunchDaemons/com.colima.graceful-shutdown.plist
#   sudo xattr -c /Library/LaunchDaemons/com.colima.graceful-shutdown.plist
#   sudo launchctl bootstrap system /Library/LaunchDaemons/com.colima.graceful-shutdown.plist
#
# VERIFY:
#   sudo launchctl list | grep colima        # should show a PID
#   tail -f /tmp/colima-shutdown.log         # should show "started (PID ...)"
#
# UPDATE SCRIPT (after changes):
#   sudo cp scripts/colima-shutdown-guard.sh /usr/local/bin/colima-shutdown-guard.sh
#   sudo xattr -c /usr/local/bin/colima-shutdown-guard.sh
#   sudo launchctl kickstart -k system/com.colima.graceful-shutdown
#
# UNINSTALL:
#   sudo launchctl bootout system/com.colima.graceful-shutdown
#   sudo rm /Library/LaunchDaemons/com.colima.graceful-shutdown.plist
#   sudo rm /usr/local/bin/colima-shutdown-guard.sh

LOGFILE="/tmp/colima-shutdown.log"
COLIMA="/opt/homebrew/bin/colima"
HEARTBEAT_INTERVAL=300  # print a heartbeat every 5 minutes
# Daemon runs as root — needs HOME for ~/.lima config and PATH for Homebrew binaries
export HOME="/Users/juandi"
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOGFILE"
}

colima_status() {
    "$COLIMA" status 2>&1 | grep -E 'running|stopped|error' | head -1 || echo "unknown"
}

cleanup() {
    log "⚠️  SIGTERM received — macOS is shutting down"
    log "→ Colima status before stop: $(colima_status)"
    log "→ Running: colima stop (timeout 90s)..."
    "$COLIMA" stop >> "$LOGFILE" 2>&1 &
    COLIMA_PID=$!
    # wait up to 90s then force-stop
    for i in $(seq 1 90); do
        kill -0 $COLIMA_PID 2>/dev/null || break
        sleep 1
    done
    if kill -0 $COLIMA_PID 2>/dev/null; then
        log "⏱️  colima stop timed out after 90s — forcing with colima stop --force"
        "$COLIMA" stop --force >> "$LOGFILE" 2>&1
    else
        wait $COLIMA_PID
        EXIT_CODE=$?
        if [ $EXIT_CODE -eq 0 ]; then
            log "✅ colima stop completed cleanly"
        else
            log "❌ colima stop exited with code $EXIT_CODE"
        fi
    fi
    log "--- shutdown guard done, exiting ---"
    exit 0
}

trap cleanup SIGTERM SIGINT

log "=========================================="
log "colima-shutdown-guard started (PID $$)"
log "Colima path: $COLIMA"
log "Colima status: $(colima_status)"
log "Watching for macOS shutdown signal (SIGTERM)..."
log "=========================================="

TICK=0
while true; do
    sleep 60 &
    wait $!
    TICK=$((TICK + 1))
    if [ $((TICK * 60)) -ge $HEARTBEAT_INTERVAL ]; then
        log "💓 heartbeat — still running | colima: $(colima_status)"
        TICK=0
    fi
done
