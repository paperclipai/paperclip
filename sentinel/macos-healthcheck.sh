#!/bin/bash
# SENTINEL macOS Health Check Script
# Deploy to: ~/sentinel-logs/ (M4 + M1)
# LaunchAgent: com.evohaus.sentinel-mac.plist (every 30 min)

set -euo pipefail

WEBHOOK_URL="${SENTINEL_WEBHOOK:-https://nail.n8n.evohaus.org/webhook/sentinel-alert}"
MACHINE_NAME="${SENTINEL_MACHINE:-$(hostname -s)}"
LOG_DIR="$HOME/sentinel-logs"
mkdir -p "$LOG_DIR"

TIMESTAMP=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
STATUS="OK"
FINDINGS=""

echo "[$TIMESTAMP] SENTINEL macOS Health Check Starting on $MACHINE_NAME..."

# 1. MEMORY PRESSURE
MEM_PRESSURE=$(memory_pressure 2>/dev/null | grep "System-wide memory free percentage" | awk '{print $NF}' | tr -d '%')
if [ -n "$MEM_PRESSURE" ] && [ "$MEM_PRESSURE" -lt 10 ]; then
  STATUS="CRITICAL"
  FINDINGS="$FINDINGS | MEM_PRESSURE: ${MEM_PRESSURE}% free"
elif [ -n "$MEM_PRESSURE" ] && [ "$MEM_PRESSURE" -lt 25 ]; then
  [ "$STATUS" = "OK" ] && STATUS="WARNING"
  FINDINGS="$FINDINGS | MEM_PRESSURE: ${MEM_PRESSURE}% free"
fi

# 2. SWAP CHECK
SWAP_USED_MB=$(sysctl vm.swapusage 2>/dev/null | awk -F'used = ' '{print $2}' | awk '{printf "%.0f", $1}')
SWAP_USED_MB=${SWAP_USED_MB:-0}
if [ "$SWAP_USED_MB" -gt 2048 ]; then
  STATUS="CRITICAL"
  FINDINGS="$FINDINGS | SWAP: ${SWAP_USED_MB}MB used (THRASHING RISK)"
elif [ "$SWAP_USED_MB" -gt 500 ]; then
  [ "$STATUS" = "OK" ] && STATUS="WARNING"
  FINDINGS="$FINDINGS | SWAP: ${SWAP_USED_MB}MB used"
fi

# 3. DISK CHECK
DISK_PCT=$(df -h / | tail -1 | awk '{print $5}' | tr -d '%')
if [ "$DISK_PCT" -gt 85 ]; then
  STATUS="CRITICAL"
  FINDINGS="$FINDINGS | DISK: ${DISK_PCT}% used"
elif [ "$DISK_PCT" -gt 70 ]; then
  [ "$STATUS" = "OK" ] && STATUS="WARNING"
  FINDINGS="$FINDINGS | DISK: ${DISK_PCT}% used"
fi

# 4. CPU LOAD
LOAD_1M=$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}')
LOAD_1M=${LOAD_1M:-0}
NCPU=$(sysctl -n hw.ncpu 2>/dev/null || echo 8)
LOAD_PER_CPU=$(echo "$LOAD_1M $NCPU" | awk '{printf "%.1f", $1/$2}')
HIGH_LOAD=$(echo "$LOAD_PER_CPU" | awk '{print ($1 > 3.0) ? "1" : "0"}')
if [ "$HIGH_LOAD" = "1" ]; then
  [ "$STATUS" = "OK" ] && STATUS="WARNING"
  FINDINGS="$FINDINGS | LOAD: ${LOAD_1M} (${LOAD_PER_CPU}/core)"
fi

# 5. PROCESS CENSUS
NODE_COUNT=$(pgrep -f node 2>/dev/null | wc -l | tr -d ' ')
PYTHON_COUNT=$(pgrep -f python 2>/dev/null | wc -l | tr -d ' ')
ELECTRON_COUNT=$(pgrep -f Electron 2>/dev/null | wc -l | tr -d ' ')

if [ "$NODE_COUNT" -gt 50 ]; then
  [ "$STATUS" = "OK" ] && STATUS="WARNING"
  FINDINGS="$FINDINGS | NODE_EXPLOSION: ${NODE_COUNT} processes"
fi

# 6. TAILSCALE CHECK
TAILSCALE_BIN="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
[ ! -x "$TAILSCALE_BIN" ] && TAILSCALE_BIN=$(which tailscale 2>/dev/null || echo "")
if [ -n "$TAILSCALE_BIN" ]; then
  TS_STATUS=$("$TAILSCALE_BIN" status 2>&1 | head -1 || echo "not running")
  if echo "$TS_STATUS" | grep -qi "stopped\|error\|not running\|failed"; then
    [ "$STATUS" = "OK" ] && STATUS="WARNING"
    FINDINGS="$FINDINGS | TAILSCALE: down"
  fi
else
  FINDINGS="$FINDINGS | TAILSCALE: binary not found"
fi

# LOG RESULT
RESULT="[$TIMESTAMP] MACHINE=$MACHINE_NAME STATUS=$STATUS DISK=${DISK_PCT}% SWAP=${SWAP_USED_MB}MB LOAD=${LOAD_1M} NODE=${NODE_COUNT} PYTHON=${PYTHON_COUNT}${FINDINGS}"
echo "$RESULT" >> "$LOG_DIR/mac-health.log"
echo "$RESULT"

# ALERT IF NOT OK
if [ "$STATUS" != "OK" ]; then
  curl -s -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "{
      \"type\": \"sentinel_mac_health\",
      \"machine\": \"$MACHINE_NAME\",
      \"severity\": \"$(echo $STATUS | tr '[:upper:]' '[:lower:]')\",
      \"finding\": \"$FINDINGS\",
      \"disk_pct\": $DISK_PCT,
      \"swap_used_mb\": $SWAP_USED_MB,
      \"load_1m\": \"$LOAD_1M\",
      \"node_count\": $NODE_COUNT,
      \"python_count\": $PYTHON_COUNT,
      \"timestamp\": \"$TIMESTAMP\"
    }" 2>/dev/null || echo "WARNING: Failed to send alert to webhook"
fi

echo "[$TIMESTAMP] SENTINEL macOS Health Check Complete on $MACHINE_NAME: $STATUS"
