#!/bin/bash
# sync-upstream.sh
# Sincroniza tu fork de Paperclip con el upstream (paperclipai/paperclip)
# manteniendo tus customizaciones intactas.
#
# Uso: bash scripts/sync-upstream.sh
#
# Qué hace:
#   1. Agrega upstream remote si no existe
#   2. Fetch upstream master
#   3. Merge upstream/master en tu branch actual
#   4. Si hay conflictos, los lista y te deja resolverlos
#   5. Regenera pnpm-lock.yaml si cambió
#
# Archivos que SIEMPRE conservan TU versión en conflicto:
#   - CLAUDE.md (tu registro de agentes)
#   - scripts/assign-skills-to-agents.sh (tu script de asignación)
#   - skills/* custom (tus skills no existen upstream)

set -euo pipefail

UPSTREAM_URL="https://github.com/paperclipai/paperclip.git"
UPSTREAM_BRANCH="master"

cd "$(git rev-parse --show-toplevel)"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║    Paperclip Upstream Sync                              ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ─── Step 1: Ensure upstream remote exists ───
if ! git remote get-url upstream > /dev/null 2>&1; then
  echo "Adding upstream remote: $UPSTREAM_URL"
  git remote add upstream "$UPSTREAM_URL"
else
  echo "✓ upstream remote exists"
fi

# ─── Step 2: Fetch upstream ───
echo ""
echo "Fetching upstream/$UPSTREAM_BRANCH..."
RETRY=0
MAX_RETRIES=4
while [ $RETRY -lt $MAX_RETRIES ]; do
  if git fetch upstream $UPSTREAM_BRANCH 2>&1; then
    echo "✓ Fetch successful"
    break
  fi
  RETRY=$((RETRY + 1))
  if [ $RETRY -lt $MAX_RETRIES ]; then
    WAIT=$((2 ** RETRY))
    echo "  Fetch failed, retrying in ${WAIT}s... ($RETRY/$MAX_RETRIES)"
    sleep $WAIT
  else
    echo "ERROR: Could not fetch upstream after $MAX_RETRIES attempts."
    exit 1
  fi
done

# ─── Step 3: Show what's new ───
CURRENT_BRANCH=$(git branch --show-current)
echo ""
echo "Current branch: $CURRENT_BRANCH"

BEHIND=$(git rev-list --count HEAD..upstream/$UPSTREAM_BRANCH 2>/dev/null || echo "0")
AHEAD=$(git rev-list --count upstream/$UPSTREAM_BRANCH..HEAD 2>/dev/null || echo "0")

echo "Your branch is $AHEAD commits ahead, $BEHIND commits behind upstream/$UPSTREAM_BRANCH"
echo ""

if [ "$BEHIND" -eq 0 ]; then
  echo "✓ Already up to date with upstream. Nothing to do."
  exit 0
fi

# Show summary of upstream changes
echo "New upstream commits ($BEHIND):"
echo "────────────────────────────────────────────────────────────"
git log --oneline HEAD..upstream/$UPSTREAM_BRANCH | head -20
if [ "$BEHIND" -gt 20 ]; then
  echo "  ... and $((BEHIND - 20)) more commits"
fi
echo ""

read -p "Merge upstream/$UPSTREAM_BRANCH into $CURRENT_BRANCH? (y/N) " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

# ─── Step 4: Files to always keep ours ───
# These are your customizations that should never be overwritten
OURS_FILES=(
  "CLAUDE.md"
  "scripts/assign-skills-to-agents.sh"
  "scripts/assign-gstack-to-agents.sh"
)

# ─── Step 5: Merge ───
echo ""
echo "Merging upstream/$UPSTREAM_BRANCH..."

if git merge upstream/$UPSTREAM_BRANCH --no-edit 2>&1; then
  echo ""
  echo "✓ Merge successful — no conflicts!"
else
  echo ""
  echo "⚠  Merge conflicts detected. Resolving known files..."

  # Auto-resolve known files with "ours" strategy
  for f in "${OURS_FILES[@]}"; do
    if git diff --name-only --diff-filter=U | grep -q "^${f}$"; then
      echo "  Keeping YOUR version: $f"
      git checkout --ours "$f"
      git add "$f"
    fi
  done

  # Auto-resolve pnpm-lock.yaml with theirs (will be regenerated)
  if git diff --name-only --diff-filter=U | grep -q "pnpm-lock.yaml"; then
    echo "  Taking upstream version: pnpm-lock.yaml (will regenerate)"
    git checkout --theirs pnpm-lock.yaml
    git add pnpm-lock.yaml
  fi

  # Check remaining conflicts
  REMAINING=$(git diff --name-only --diff-filter=U 2>/dev/null || true)
  if [ -n "$REMAINING" ]; then
    echo ""
    echo "⚠  Manual resolution needed for:"
    echo "$REMAINING"
    echo ""
    echo "Resolve them, then run:"
    echo "  git add <resolved-files>"
    echo "  git commit"
    echo "  bash scripts/sync-upstream.sh  # to verify"
    exit 1
  fi

  # All conflicts resolved, complete the merge
  git commit --no-edit
  echo ""
  echo "✓ All conflicts resolved and merged!"
fi

# ─── Step 6: Summary ───
echo ""
echo "════════════════════════════════════════════════════════════"
echo "  Sync complete!"
echo "  Merged $BEHIND upstream commits into $CURRENT_BRANCH"
echo ""
echo "  Next steps:"
echo "    1. Test: pnpm dev (or use Desktop launcher)"
echo "    2. If all good: git push origin $CURRENT_BRANCH"
echo "    3. Verify agents still work in Paperclip UI"
echo "════════════════════════════════════════════════════════════"
