#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

LOCAL_BIN_DIR="$SCRIPT_DIR/.paperclip/bin"
mkdir -p "$LOCAL_BIN_DIR"

if [[ ! -x "$LOCAL_BIN_DIR/pnpm" ]]; then
  cat > "$LOCAL_BIN_DIR/pnpm" <<'EOF'
#!/usr/bin/env bash
exec corepack pnpm@9.15.4 "$@"
EOF
  chmod +x "$LOCAL_BIN_DIR/pnpm"
fi

echo "[build] Running Brabrix Agent build..."
PATH="$LOCAL_BIN_DIR:$PATH" corepack pnpm@9.15.4 run build
echo "[build] Build finished successfully."
