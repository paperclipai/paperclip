#!/bin/sh
set -e

# If running as root, do the UID/GID remapping and use gosu
if [ "$(id -u)" = "0" ]; then
  PUID=${USER_UID:-1000}
  PGID=${USER_GID:-1000}
  changed=0

  if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
    changed=1
  fi

  if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
    changed=1
  fi

  # Clean up old run logs for ALL instances (Issue 3)
  for instance_dir in /paperclip/instances/*; do
    RUN_LOG_DIR="${instance_dir}/data/run-logs"
    if [ -d "$RUN_LOG_DIR" ]; then
        echo "Cleaning logs in $RUN_LOG_DIR"
        find "$RUN_LOG_DIR" -type f -mtime +7 -delete
    fi
  done

  # Clean up Claude Code temp/cache files that accumulate
  for AGENT_DIR in /paperclip/instances/*/agents/*/; do
    if [ -d "${AGENT_DIR}.claude" ]; then
      CACHE_SIZE=$(du -sm "${AGENT_DIR}.claude" 2>/dev/null | cut -f1)
      if [ "${CACHE_SIZE:-0}" -gt 50 ]; then
        echo "Pruning large .claude cache (${CACHE_SIZE}MB) in $AGENT_DIR"
        rm -rf "${AGENT_DIR}.claude/cache" 2>/dev/null || true
      fi
    fi
  done

  # Report disk usage
  USED=$(du -sm /paperclip 2>/dev/null | cut -f1)
  echo "Volume /paperclip usage: ${USED}MB"

  # Issue 2: Optimized permission fix
  # Only chown if first run OR if UID/GID actually changed
  if [ ! -f /paperclip/.permissions_fixed ] || [ "$changed" = "1" ]; then
    echo "Fixing volume permissions (this may take a moment)..."
    chown -R node:node /paperclip
    touch /paperclip/.permissions_fixed
  fi

  exec gosu node "$@"
else
  # Issue 4: Accurate comment and improved directory creation
  # Entered if running as non-root (e.g., via Docker --user or Railway custom setup)
  echo "Running as non-root user $(id -u)"
  if ! mkdir -p /paperclip/instances 2>/dev/null; then
      echo "Warning: Could not create /paperclip/instances. Ensure volume is writable."
  fi
  exec "$@"
fi
