#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PAPERCLIP_DIR="$REPO_ROOT/.paperclip"
LOCAL_BIN_DIR="$PAPERCLIP_DIR/bin"

mkdir -p "$LOCAL_BIN_DIR"

cat > "$LOCAL_BIN_DIR/pnpm" <<'EOF'
#!/usr/bin/env bash
exec corepack pnpm@9.15.4 "$@"
EOF
chmod +x "$LOCAL_BIN_DIR/pnpm"

if [[ ! -f "$REPO_ROOT/.env" ]]; then
  cat > "$REPO_ROOT/.env" <<'EOF'
# Local dev: leave DATABASE_URL unset to use embedded PostgreSQL.
PORT=3100
SERVE_UI=false

BETTER_AUTH_SECRET=brabrix-dev-secret
PAPERCLIP_PUBLIC_APP_NAME=Brabrix Agent
VITE_PUBLIC_APP_NAME=Brabrix Agent

BRABRIX_API_URL=
BRABRIX_AGENT_TOKEN=
BRABRIX_PROJECT_ID=
EOF
  echo "[brabrix-up] Created .env with local defaults."
fi

if [[ ! -f "$PAPERCLIP_DIR/.env" ]]; then
  echo "[brabrix-up] Worktree env not found. Initializing worktree..."
  if ! corepack pnpm@9.15.4 paperclipai worktree init --no-seed; then
    corepack pnpm@9.15.4 paperclipai worktree init --no-seed --force
  fi
fi

echo "[brabrix-up] Starting Brabrix Agent dev server..."
echo "[brabrix-up] URL expected: http://127.0.0.1:3101 (or next available port)"
PATH="$LOCAL_BIN_DIR:$PATH" corepack pnpm@9.15.4 --filter @paperclipai/server exec tsx ../scripts/dev-runner.ts watch "$@"
