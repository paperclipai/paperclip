#!/bin/bash
# Setup a Claude Max subscription slot for Paperclip agent pool.
# Usage: ./setup-subscription-slot.sh <slot-name>
#
# Creates a credential directory and launches Claude login for that slot.
# Claude CLI resolves: $CLAUDE_CONFIG_DIR/.credentials.json
# After setup, assign to agents via runtimeConfig.subscriptionConfigDir.

set -euo pipefail

SLOT_NAME="${1:-}"
if [ -z "$SLOT_NAME" ]; then
  echo "Usage: $0 <slot-name>"
  echo "Example: $0 slot-1"
  exit 1
fi

SLOT_DIR="$HOME/.paperclip/subscription-slots/$SLOT_NAME"

if [ -f "$SLOT_DIR/.credentials.json" ]; then
  echo "Slot '$SLOT_NAME' already exists. Re-authenticating will invalidate the previous session."
  read -rp "Continue? [y/N] " confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

mkdir -p "$SLOT_DIR"
chmod 700 "$SLOT_DIR"

echo "=== Setting up subscription slot: $SLOT_NAME ==="
echo "Config dir: $SLOT_DIR"
echo ""
echo "Logging in..."
CLAUDE_CONFIG_DIR="$SLOT_DIR" claude auth login

echo ""
echo "Verifying..."
CLAUDE_CONFIG_DIR="$SLOT_DIR" claude auth status

echo ""
echo "Done. Assign to agents with:"
echo "  PATCH /agents/:id"
echo "  runtimeConfig.subscriptionConfigDir: \"$SLOT_DIR\""
