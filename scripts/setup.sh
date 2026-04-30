#!/usr/bin/env bash
set -euo pipefail

PAPERCLIP_DIR="$HOME/.paperclip"
WORKSPACE_DIR="$PAPERCLIP_DIR/instances/default/workspaces"

# Find the workspace ID (there's usually one)
WORKSPACE_ID=$(ls "$WORKSPACE_DIR" | head -1)

if [ -z "$WORKSPACE_ID" ]; then
  echo "No Paperclip workspace found. Run paperclip onboard first."
  exit 1
fi

AGENTS_TARGET="$WORKSPACE_DIR/$WORKSPACE_ID/agents"

echo "Syncing MCP configs to $AGENTS_TARGET..."

for agent_dir in agents/*/; do
  agent_name=$(basename "$agent_dir")
  src="$agent_dir/mcp.json"
  dst="$AGENTS_TARGET/$agent_name/mcp.json"

  if [ -f "$src" ]; then
    mkdir -p "$(dirname "$dst")"
    # Symlink so changes in repo propagate automatically
    ln -sf "$(pwd)/$src" "$dst"
    echo "  linked: $agent_name/mcp.json"
  fi
done

echo "Done."