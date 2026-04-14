#!/usr/bin/env bash
# promote-skill.sh — Push a skill from the paperclip session workspace to
# claude-private and import it into the Paperclip company skills library.
#
# Usage:
#   ./scripts/promote-skill.sh <skill-name> [--no-git] [--no-import]
#
# Environment (required for --no-import=false):
#   PAPERCLIP_API_URL        defaults to http://127.0.0.1:3100
#   PAPERCLIP_API_KEY        bearer token
#   PAPERCLIP_COMPANY_ID     target company
#
# Steps:
#   1. Copy skill from paperclip/skills/<name>/ → claude-private/skills/<name>/
#   2. Commit + push in claude-private (unless --no-git)
#   3. POST /api/companies/:companyId/skills/import with local path (unless --no-import)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE_PRIVATE="${CLAUDE_PRIVATE_DIR:-"$(dirname "$REPO_ROOT")/claude-private"}"
API_URL="${PAPERCLIP_API_URL:-http://127.0.0.1:3100}"
COMPANY_ID="${PAPERCLIP_COMPANY_ID:-}"
API_KEY="${PAPERCLIP_API_KEY:-}"

NO_GIT=false
NO_IMPORT=false

usage() {
  echo "Usage: $0 <skill-name> [--no-git] [--no-import]"
  echo ""
  echo "  skill-name   Directory name under paperclip/skills/"
  echo "  --no-git     Skip commit/push to claude-private"
  echo "  --no-import  Skip Paperclip company skills import"
  exit 1
}

SKILL_NAME=""
for arg in "$@"; do
  case "$arg" in
    --no-git)     NO_GIT=true ;;
    --no-import)  NO_IMPORT=true ;;
    --help|-h)    usage ;;
    -*)           echo "Unknown flag: $arg"; usage ;;
    *)            SKILL_NAME="$arg" ;;
  esac
done

if [[ -z "$SKILL_NAME" ]]; then
  usage
fi

SOURCE="$REPO_ROOT/skills/$SKILL_NAME"
DEST="$CLAUDE_PRIVATE/skills/$SKILL_NAME"

if [[ ! -d "$SOURCE" ]]; then
  echo "ERROR: skill not found at $SOURCE"
  exit 1
fi

if [[ ! -d "$CLAUDE_PRIVATE" ]]; then
  echo "ERROR: claude-private repo not found at $CLAUDE_PRIVATE"
  echo "  Set CLAUDE_PRIVATE_DIR env var or clone to $(dirname "$REPO_ROOT")/claude-private"
  exit 1
fi

echo "==> Promoting skill: $SKILL_NAME"

# ── Step 1: Sync skill files ──────────────────────────────────────────────────
echo "  [1/3] Syncing $SOURCE → $DEST"
mkdir -p "$(dirname "$DEST")"
rsync -a --delete "$SOURCE/" "$DEST/" 2>/dev/null || {
  # rsync fallback: plain copy
  rm -rf "$DEST"
  cp -r "$SOURCE" "$DEST"
}
echo "        Done."

# ── Step 2: Commit + push to claude-private ──────────────────────────────────
if [[ "$NO_GIT" == "false" ]]; then
  echo "  [2/3] Committing to claude-private"
  cd "$CLAUDE_PRIVATE"

  if ! git diff --quiet HEAD -- "skills/$SKILL_NAME" 2>/dev/null || \
     [[ -n "$(git ls-files --others --exclude-standard "skills/$SKILL_NAME")" ]]; then
    git add "skills/$SKILL_NAME"
    git commit -m "$(cat <<EOF
feat(skills/$SKILL_NAME): promote from session workspace

Auto-promoted by scripts/promote-skill.sh from:
  $SOURCE

Co-Authored-By: Paperclip <noreply@paperclip.ing>
EOF
)"
    echo "        Committed."
    if git remote | grep -q origin; then
      git push origin main
      echo "        Pushed to origin."
    else
      echo "        WARNING: no remote 'origin' — skipping push."
      echo "        Add remote: git remote add origin https://github.com/anhermon/claude-private.git"
    fi
  else
    echo "        No changes to commit."
  fi
  cd "$REPO_ROOT"
else
  echo "  [2/3] Skipping git (--no-git)"
fi

# ── Step 3: Import into Paperclip company skills library ─────────────────────
if [[ "$NO_IMPORT" == "false" ]]; then
  echo "  [3/3] Importing into Paperclip skills library"

  if [[ -z "$COMPANY_ID" ]]; then
    echo "        ERROR: PAPERCLIP_COMPANY_ID is not set"
    exit 1
  fi
  if [[ -z "$API_KEY" ]]; then
    echo "        ERROR: PAPERCLIP_API_KEY is not set"
    exit 1
  fi

  ABS_DEST="$(cd "$DEST" && pwd -W 2>/dev/null || pwd)"
  RESPONSE=$(curl -sS -X POST "$API_URL/api/companies/$COMPANY_ID/skills/import" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"source\": \"$ABS_DEST\"}")

  if echo "$RESPONSE" | grep -q '"id"'; then
    echo "        Imported. Response: $RESPONSE"
  elif echo "$RESPONSE" | grep -q '"error"'; then
    echo "        WARNING: Import returned error — $RESPONSE"
    echo "        (Skill may already be installed; try install-update instead)"
  else
    echo "        Response: $RESPONSE"
  fi
else
  echo "  [3/3] Skipping import (--no-import)"
fi

echo ""
echo "Done. Skill '$SKILL_NAME' promoted to claude-private/skills/$SKILL_NAME"
