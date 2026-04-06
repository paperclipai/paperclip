#!/usr/bin/env bash

set -euo pipefail

UPSTREAM_URL="https://github.com/paperclipai/paperclip.git"
BASE_BRANCH="master"
INTEGRATION_BRANCH="integration/upstream-sync"
SUMMARY_FILE=".upstream-sync-summary.md"

git config user.email "actions@github.com"
git config user.name "GitHub Actions"

if git remote get-url upstream >/dev/null 2>&1; then
  git remote set-url upstream "$UPSTREAM_URL"
else
  git remote add upstream "$UPSTREAM_URL"
fi

git fetch origin "$BASE_BRANCH"
git fetch upstream "$BASE_BRANCH"

if [ "$(git rev-parse "origin/$BASE_BRANCH")" = "$(git rev-parse "upstream/$BASE_BRANCH")" ]; then
  cat > "$SUMMARY_FILE" <<EOF
## Upstream Sync $(date +%Y-%m-%d)

No new commits found between \`origin/$BASE_BRANCH\` and \`upstream/$BASE_BRANCH\`.
EOF
  touch .upstream-sync-noop
  exit 0
fi

git checkout -B "$INTEGRATION_BRANCH" "origin/$BASE_BRANCH"

# Check if there are any high-risk path differences
HIGH_RISK_COMMITS=""
for path in \
  "server/src/routes/" \
  "packages/db/src/schema/" \
  "server/src/services/heartbeat.ts" \
  "packages/shared/src/constants.ts"
do
  if git diff --name-only "origin/$BASE_BRANCH..upstream/$BASE_BRANCH" 2>/dev/null | rg -q "^${path}"; then
    HIGH_RISK_COMMITS="true"
    break
  fi
done

# Check for uncommitted changes in high-risk paths
HAS_UNCOMMITTED=""
if git status --porcelain | rg -q '.'; then
  if git diff --cached --name-only | rg -q '^server/src/routes/'; then
    HAS_UNCOMMITTED="server/src/routes/"
  elif git diff --cached --name-only | rg -q '^packages/db/src/schema/'; then
    HAS_UNCOMMITTED="packages/db/src/schema/"
  fi
fi

# Abort any in-progress merge
git merge --abort 2>/dev/null || true

if ! git merge --no-edit "upstream/$BASE_BRANCH"; then
  echo "MERGE_CONFLICT: upstream merge had conflicts with local fork changes." >&2
  echo "This is expected for heavily-modified forks. Skipping upstream sync for this cycle." >&2
  git merge --abort 2>/dev/null || true

  # For forked repos, detect if origin is ahead of upstream (fork custom work)
  origin_ahead=$(git rev-list --count "upstream/$BASE_BRANCH..origin/$BASE_BRANCH" 2>/dev/null || echo "0")
  upstream_ahead=$(git rev-list --count "origin/$BASE_BRANCH..upstream/$BASE_BRANCH" 2>/dev/null || echo "0")

  if [ "$origin_ahead" -gt 0 ] && [ "$upstream_ahead" -eq 0 ]; then
    echo "Detected fork-ahead pattern ($origin_ahead commits ahead of upstream). Creating no-op."
    cat > "$SUMMARY_FILE" <<EOF
## Upstream Sync $(date +%Y-%m-%d)

Sync skipped: merge conflict between \`origin/$BASE_BRANCH\` and \`upstream/$BASE_BRANCH\`.
Fork is **$origin_ahead commits ahead** of upstream with local customizations.

This is expected behavior for forked repositories with significant local work.
The \`integration/upstream-sync\` branch is not updated this cycle.
EOF
    touch .upstream-sync-noop
    exit 0
  fi

  # For genuine upstream changes with conflicts, require manual resolution
  echo "Upstream has changes that conflict with local work. Manual merge required." >&2
  cat > "$SUMMARY_FILE" <<EOF
## Upstream Sync $(date +%Y-%m-%d)

Sync failed: merge conflict between \`origin/$BASE_BRANCH\` and \`upstream/$BASE_BRANCH\`.
Upstream has new commits that require manual resolution.

**Manual intervention required.** Please resolve conflicts in \`$INTEGRATION_BRANCH\` and push.
EOF
  # Do NOT touch .upstream-sync-noop — let the workflow report failure with context
  exit 0
fi

new_commit_count=$(git log --oneline "origin/$BASE_BRANCH..HEAD" | wc -l | tr -d ' ')
if [ "$new_commit_count" = "0" ]; then
  cat > "$SUMMARY_FILE" <<EOF
## Upstream Sync $(date +%Y-%m-%d)

No net commits found between \`origin/$BASE_BRANCH\` and \`$INTEGRATION_BRANCH\`.
EOF
  touch .upstream-sync-noop
  exit 0
fi

migration_note=""
if git diff --name-only "origin/$BASE_BRANCH..HEAD" | rg -q '^packages/db/src/migrations/'; then
  migration_note="**WARNING: migration files changed. Verify migration safety before merge.**"
fi

high_risk_paths=""
for path in \
  "server/src/routes/" \
  "packages/db/src/schema/" \
  "server/src/services/heartbeat.ts" \
  "packages/shared/src/constants.ts"
do
  if git diff --name-only "origin/$BASE_BRANCH..HEAD" | rg -q "^${path}"; then
    high_risk_paths+="- \`${path}\`"$'\n'
  fi
done

cat > "$SUMMARY_FILE" <<EOF
## Upstream Sync $(date +%Y-%m-%d)

New commits from \`upstream/$BASE_BRANCH\`: **$new_commit_count**

${migration_note}

### High-risk areas touched
${high_risk_paths:-_none_}

### Commit summary
\`\`\`
$(git log --oneline "origin/$BASE_BRANCH..HEAD")
\`\`\`

### Promotion checklist
- [ ] Typecheck, tests, and build pass
- [ ] Migration changes reviewed for compatibility
- [ ] High-risk areas reviewed
- [ ] Any not-yet-wired UI changes documented
- [ ] Deployment triggered manually via \`deploy-vultr\` workflow_dispatch
EOF

git push origin "$INTEGRATION_BRANCH" --force-with-lease
