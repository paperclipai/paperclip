#!/bin/sh
set -e

# Run onboard first to create config if it doesn't exist
if [ ! -f "/paperclip/instances/default/config.json" ]; then
  echo "============================================"
  echo "Running onboard to initialize Paperclip..."
  echo "============================================"
  pnpm paperclipai onboard --defaults || true
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
