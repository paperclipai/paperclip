#!/usr/bin/env bash
# Out-of-band crash-loop detector for the Paperclip launchd service.
#
# This script intentionally uses only local filesystem, syslog and macOS
# notifications. It remains available when the control-plane process and its
# database/API are unavailable.
set -euo pipefail

STATE_DIR="${PAPERCLIP_CRASH_LOOP_STATE_DIR:-$HOME/paperclip/.devlogs}"
WINDOW_SECONDS="${PAPERCLIP_CRASH_LOOP_WINDOW_SECONDS:-300}"
THRESHOLD="${PAPERCLIP_CRASH_LOOP_THRESHOLD:-3}"
mkdir -p "$STATE_DIR"

state_file="$STATE_DIR/paperclip-source-crash-loop-attempts"
alert_file="$STATE_DIR/paperclip-source-crash-loop-alert.json"
now="$(date +%s)"
cutoff=$((now - WINDOW_SECONDS))
tmp_file="$state_file.$$"

if [ -f "$state_file" ]; then
  awk -v cutoff="$cutoff" '$1 >= cutoff { print $1 }' "$state_file" > "$tmp_file" || true
else
  : > "$tmp_file"
fi
printf '%s\n' "$now" >> "$tmp_file"
mv "$tmp_file" "$state_file"

attempts="$(wc -l < "$state_file" | tr -d ' ')"
if [ "$attempts" -lt "$THRESHOLD" ]; then
  exit 0
fi

# Emit once per failure burst. A fresh attempt window after recovery creates a
# new artifact and notification should the service regress later.
previous_window_start="$(sed -n 's/.*\"windowStart\":\([0-9]*\).*/\1/p' "$alert_file" 2>/dev/null || true)"
if [ -n "$previous_window_start" ] && [ "$previous_window_start" -ge "$cutoff" ]; then
  exit 0
fi

window_start="$(head -n 1 "$state_file")"
printf '{"service":"ie.thinkstack.paperclip-source","kind":"crash_loop","attempts":%s,"threshold":%s,"windowSeconds":%s,"windowStart":%s,"detectedAt":%s}\n' \
  "$attempts" "$THRESHOLD" "$WINDOW_SECONDS" "$window_start" "$now" > "$alert_file"

message="Paperclip source crash loop: $attempts failed starts in $WINDOW_SECONDS seconds. Evidence: $alert_file"
/usr/bin/logger -t paperclip-crash-loop-alert -- "$message" || true
/usr/bin/osascript -e "display notification \"$message\" with title \"Paperclip outage\" sound name \"Basso\"" >/dev/null 2>&1 || true
