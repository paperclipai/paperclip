#!/bin/bash
# One-command deploy: push to GitHub + deploy to Fly.io
# Usage: ./scripts/deploy.sh
#        ./scripts/deploy.sh "optional commit message"

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
GH_REMOTE="artithea"
GH_TOKEN_FILE="$HOME/.paperclip-github-token"
FLY_APP="${FLY_APP:-paperclip-holding}"

log() { echo "🚀 $*"; }

# ── Optional: commit staged changes first ─────────────────────────────────────
if ! git diff --cached --quiet 2>/dev/null; then
  MSG="${1:-"chore: update"}"
  log "Committing staged changes: $MSG"
  git commit -m "$MSG"
fi

# ── Push to GitHub ────────────────────────────────────────────────────────────
# Load token if saved, otherwise use existing remote
if [ -f "$GH_TOKEN_FILE" ]; then
  TOKEN=$(cat "$GH_TOKEN_FILE")
  git remote set-url "$GH_REMOTE" "https://${TOKEN}@github.com/Artithea/paperclip.git" 2>/dev/null || \
  git remote add "$GH_REMOTE" "https://${TOKEN}@github.com/Artithea/paperclip.git"
fi

if git remote get-url "$GH_REMOTE" >/dev/null 2>&1; then
  log "Pushing $BRANCH → GitHub (Artithea/paperclip)..."
  git push "$GH_REMOTE" "$BRANCH" && log "GitHub ✅"
else
  log "WARNING: remote '$GH_REMOTE' not found, skipping GitHub push"
fi

# ── Deploy to Fly.io ──────────────────────────────────────────────────────────
log "Deploying to Fly.io ($FLY_APP)..."
fly deploy --app "$FLY_APP" --remote-only
log "Fly.io ✅"

log "Done! Branch: $BRANCH"
