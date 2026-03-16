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

if ! git merge --no-edit "upstream/$BASE_BRANCH"; then
  echo "MERGE_CONFLICT: manual resolution required" >&2
  git merge --abort 2>/dev/null || true
  exit 1
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
