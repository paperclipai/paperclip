#!/usr/bin/env bash
set -euo pipefail

# Pre-push validation for Paperclip monorepo PRs.
# Catches the 7 failure categories that cause CI rejections.
# Usage: ./scripts/pre-push-check.sh [base-branch]

BASE="${1:-origin/master}"
BRANCH="HEAD"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
FAIL=0

header() { echo -e "\n${YELLOW}[$1]${NC} $2"; }
pass()   { echo -e "  ${GREEN}PASS${NC}: $1"; }
fail()   { echo -e "  ${RED}FAIL${NC}: $1"; FAIL=1; }
warn()   { echo -e "  ${YELLOW}WARN${NC}: $1"; }

echo "=== Paperclip Pre-Push Check ==="
echo "Base: $BASE | Branch: $BRANCH"
echo ""

CHANGED_FILES=$(git diff --name-only "$BASE"..."$BRANCH" 2>/dev/null || git diff --name-only "$BASE".."$BRANCH")

# --- 1. Lockfile policy ---
header "1/7" "Lockfile policy"
if echo "$CHANGED_FILES" | grep -qx 'pnpm-lock.yaml'; then
  fail "pnpm-lock.yaml is in the diff — CI will reject this PR"
  echo "       Fix: git reset HEAD pnpm-lock.yaml && git checkout -- pnpm-lock.yaml"
else
  pass "No lockfile in diff"
fi

# --- 2. Export map corruption ---
header "2/7" "Package.json export maps"
PKG_JSONS=$(echo "$CHANGED_FILES" | grep 'package\.json$' || true)
CHECK2_FAIL=0
if [ -n "$PKG_JSONS" ]; then
  while IFS= read -r pj; do
    if git diff "$BASE"..."$BRANCH" -- "$pj" 2>/dev/null | grep -q '"./dist/'; then
      fail "$pj: exports point to ./dist/ — CI typechecks before build, this will 404"
      echo "       Fix: git checkout $BASE -- $pj"
      CHECK2_FAIL=1
    fi
  done <<< "$PKG_JSONS"
  [ "$CHECK2_FAIL" -eq 0 ] && pass "No dist/ export map changes detected"
else
  pass "No package.json changes"
fi

# --- 3. Cross-feature type leaks ---
header "3/7" "Barrel export consistency"
CHECK3_FAIL=0
for BARREL in packages/shared/src/types/index.ts packages/shared/src/index.ts packages/shared/src/validators/index.ts; do
  if echo "$CHANGED_FILES" | grep -qx "$BARREL"; then
    ADDED_MODULES=$(git diff "$BASE"..."$BRANCH" -- "$BARREL" 2>/dev/null \
      | grep '^+' | grep -v '^+++' \
      | sed -n 's|.*from "\./\([^"]*\)\.js".*|\1|p' \
      | sort -u || true)
    if [ -n "$ADDED_MODULES" ]; then
      DIR=$(dirname "$BARREL")
      for MOD in $ADDED_MODULES; do
        if ! echo "$CHANGED_FILES" | grep -q "$DIR/$MOD\\.ts"; then
          if ! git show "$BASE:$DIR/$MOD.ts" >/dev/null 2>&1; then
            fail "$BARREL exports from ./$MOD.js but $DIR/$MOD.ts is new and not in the PR"
            CHECK3_FAIL=1
          fi
        fi
      done
    fi
  fi
done
[ "$CHECK3_FAIL" -eq 0 ] && pass "Barrel exports reference only files in the PR"

# --- 4. File count sanity ---
header "4/7" "Commit scope"
FILE_COUNT=$(echo "$CHANGED_FILES" | wc -l | tr -d ' ')
if [ "$FILE_COUNT" -gt 80 ]; then
  fail "$FILE_COUNT files changed — likely includes unrelated features. Review with: git diff --name-only $BASE...$BRANCH"
elif [ "$FILE_COUNT" -gt 50 ]; then
  warn "$FILE_COUNT files changed — verify all are related to the same feature"
else
  pass "$FILE_COUNT files in diff"
fi

# --- 5. Build-order: simulation scripts after build ---
header "5/7" "CI step ordering"
for WF in .github/workflows/pr.yml .github/workflows/release.yml; do
  if echo "$CHANGED_FILES" | grep -qx "$WF"; then
    if [ -f "$WF" ]; then
      BUILD_LINE=$(grep -n "pnpm build" "$WF" | head -1 | cut -d: -f1 || echo "0")
      SIM_LINE=$(grep -n "simulate-http-adapter\|phase1-crewai\|phase1-runtime" "$WF" | head -1 | cut -d: -f1 || echo "0")
      if [ "$SIM_LINE" != "0" ] && [ "$BUILD_LINE" != "0" ] && [ "$SIM_LINE" -lt "$BUILD_LINE" ]; then
        fail "$WF: simulation scripts run before 'pnpm build' — tsx needs compiled packages"
      fi
    fi
  fi
done
pass "Simulation steps are after build"

# --- 6. CI command syntax ---
header "6/7" "pnpm workspace commands"
for WF in .github/workflows/pr.yml .github/workflows/release.yml; do
  if echo "$CHANGED_FILES" | grep -qx "$WF"; then
    if [ -f "$WF" ] && grep -q 'pnpm -C ' "$WF"; then
      fail "$WF uses 'pnpm -C <dir>' which fails in CI. Use 'cd <dir> && pnpm ...' instead"
    fi
  fi
done
pass "No pnpm -C syntax in workflows"

# --- 7. Function signature compatibility ---
header "7/7" "Upstream API compatibility"
for FILE in $(echo "$CHANGED_FILES" | grep '\.ts$' | grep -v '\.test\.' | grep -v '\.d\.ts$'); do
  ADDED_ARGS=$(git diff "$BASE"..."$BRANCH" -- "$FILE" 2>/dev/null | grep '^+' | grep -c 'function\|=>' || true)
  if [ "$ADDED_ARGS" -gt 5 ]; then
    warn "$FILE has $ADDED_ARGS+ function signature changes — verify upstream compatibility"
  fi
done
pass "No obvious signature breaks detected"

# --- Summary ---
echo ""
echo "==================================="
if [ "$FAIL" -eq 0 ]; then
  echo -e "${GREEN}ALL CHECKS PASSED${NC} — safe to push"
  exit 0
else
  echo -e "${RED}CHECKS FAILED${NC} — fix issues above before pushing"
  exit 1
fi
