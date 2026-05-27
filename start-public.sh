#!/bin/bash
set -e

echo "=== Starting Paperclip Server ==="
echo ""

# Kill any stale processes
pkill -f "embedded-postgres" 2>/dev/null || true
pkill -f "paperclip.*server" 2>/dev/null || true
sleep 2

# Clean stale DB data if needed
DB_DIR="$HOME/Documents/Paperclip/.data/instances/default/db"
if [ -d "$DB_DIR" ]; then
  echo "Cleaning stale database data..."
  rm -rf "$DB_DIR"
fi

# Start the server
echo "Starting server on port 3100..."
export TMPDIR="${TMPDIR:-/tmp}"
export PORT=3100
export SERVE_UI=true
export PAPERCLIP_HOME="$HOME/Documents/Paperclip/.data"

node --import ./node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/loader.mjs server/src/index.ts &
SERVER_PID=$!

# Wait for server to be ready
echo "Waiting for server to start..."
for i in $(seq 1 30); do
  if curl -s http://localhost:3100/health >/dev/null 2>&1; then
    echo "Server is ready at http://localhost:3100"
    break
  fi
  sleep 2
done

# Start cloudflared tunnel for public access
echo ""
echo "=== Starting Public Tunnel ==="
echo "Your Paperclip instance will be accessible from anywhere!"
echo ""
cloudflared tunnel --url http://localhost:3100
