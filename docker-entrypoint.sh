#!/bin/sh
set -e

CONFIG_DIR="/paperclip/instances/default"
CONFIG_FILE="$CONFIG_DIR/config.json"

# Create config.json if it doesn't exist
if [ ! -f "$CONFIG_FILE" ]; then
  echo "============================================"
  echo "Creating Paperclip config..."
  echo "============================================"
  mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG_FILE" << 'CONFIGEOF'
{
  "$meta": {
    "version": 1,
    "updatedAt": "2026-03-31T00:00:00.000Z",
    "source": "configure"
  },
  "database": {
    "mode": "postgres"
  },
  "logging": {
    "mode": "file"
  },
  "server": {
    "deploymentMode": "authenticated",
    "deploymentExposure": "private"
  },
  "auth": {
    "baseUrlMode": "auto"
  },
  "storage": {},
  "secrets": {}
}
CONFIGEOF
  echo "Config created at $CONFIG_FILE"
fi

# Start the server in the background
node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js &
SERVER_PID=$!

# Wait for the server to be ready
echo "Waiting for server to start..."
sleep 8

# Run bootstrap-ceo and capture the output (invite URL)
echo "============================================"
echo "Running bootstrap-ceo to generate admin invite URL..."
echo "============================================"
pnpm paperclipai auth bootstrap-ceo || echo "Bootstrap already completed or failed - check above for invite URL"
echo "============================================"

# Keep the server running
wait $SERVER_PID
