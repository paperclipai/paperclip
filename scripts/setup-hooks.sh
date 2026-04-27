#!/bin/bash
# Setup git hooks for this repository
# Run this after cloning to install pre-commit guards

set -e

HOOKS_DIR=".git/hooks"

echo "📦 Setting up git hooks..."

# Ensure hooks directory exists
mkdir -p "$HOOKS_DIR"

# Install pre-commit hook
if [ ! -f "$HOOKS_DIR/pre-commit" ]; then
  cp scripts/hooks/pre-commit "$HOOKS_DIR/pre-commit"
  chmod +x "$HOOKS_DIR/pre-commit"
  echo "✅ Pre-commit hook installed"
else
  echo "ℹ️  Pre-commit hook already exists"
fi

echo ""
echo "✨ Git hooks setup complete!"
echo ""
echo "Guard rails installed:"
echo "  • pre-commit: Prevents accidental pnpm-lock.yaml commits"
