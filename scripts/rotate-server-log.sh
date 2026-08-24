#!/bin/bash
# Rotate paperclip server.log — copy and truncate (safe for open file descriptors)
# Intended to run daily via launchd or crontab
# Uses copy-truncate: pino keeps the FD open, new writes go to the start of the same inode.
# Uses explicit PATH since launchd has a minimal environment.

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

LOG_DIR="$HOME/.paperclip/instances/default/logs"
LOG_FILE="$LOG_DIR/server.log"
MAX_SIZE=$(( 500 * 1024 * 1024 ))  # 500 MB
RETENTION_DAYS=30

# Human-readable size helper (portable, no numfmt dependency)
human_size() {
  local bytes=$1
  if [ "$bytes" -ge $(( 1024 * 1024 * 1024 )) ]; then
    echo "$(( bytes / 1024 / 1024 / 1024 ))G"
  elif [ "$bytes" -ge $(( 1024 * 1024 )) ]; then
    echo "$(( bytes / 1024 / 1024 ))M"
  elif [ "$bytes" -ge 1024 ]; then
    echo "$(( bytes / 1024 ))K"
  else
    echo "${bytes}B"
  fi
}

# Exit early if the log doesn't exist
if [ ! -f "$LOG_FILE" ]; then
  echo "server.log not found at $LOG_FILE — skipping"
  exit 0
fi

# Get size in bytes (macOS stat syntax)
SIZE=$(stat -f%z "$LOG_FILE" 2>/dev/null)
if [ -z "$SIZE" ] || [ "$SIZE" -lt "$MAX_SIZE" ]; then
  echo "server.log is $(human_size ${SIZE:-0}) — below $(( MAX_SIZE / 1024 / 1024 ))MB threshold, skipping"
  exit 0
fi

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
ARCHIVE="$LOG_DIR/server.log.$TIMESTAMP"

echo "Rotating server.log ($(human_size $SIZE)) → $ARCHIVE"

# Copy then truncate (atomic-ish for the FD)
cp "$LOG_FILE" "$ARCHIVE"
: > "$LOG_FILE"

# Compress in background
gzip "$ARCHIVE" &

# Prune old rotated logs (older than $RETENTION_DAYS days)
find "$LOG_DIR" -name 'server.log.*.gz' -mtime +$RETENTION_DAYS -delete 2>/dev/null

echo "Done. Archived: $(basename $ARCHIVE).gz"
