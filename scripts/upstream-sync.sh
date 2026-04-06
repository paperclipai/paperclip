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

# Detect fork-ahead pattern before attempting merge.
# If origin is significantly ahead of upstream with no new upstream commits,
# skip sync gracefully — this is expected for heavily-modified forks.
origin_ahead=$(git rev-list --count "upstream/$BASE_BRANCH..origin/$BASE_BRANCH" 2>/dev/null || echo "0")
upstream_ahead=$(git rev-list --count "origin/$BASE_BRANCH..upstream/$BASE_BRANCH" 2>/dev/null || echo "0")

if [ "$origin_ahead" -gt 0 ] && [ "$upstream_ahead" -eq 0 ]; then
  echo "Detected fork-ahead pattern ($origin_ahead commits ahead of upstream, 0 behind). Creating no-op."
  cat > "$SUMMARY_FILE" <<EOF
## Upstream Sync $(date +%Y-%m-%d)

Sync skipped: fork is **$origin_ahead commits ahead** of upstream with no new upstream commits.

This is expected behavior for forked repositories with significant local work.
The \`integration/upstream-sync\` branch is not updated this cycle.
EOF
  touch .upstream-sync-noop
  exit 0
fi

# The merge strategy:
# 1. Reset integration/upstream-sync to origin/master
# 2. Back up .env.example (untracked — git refuses to merge over it)
# 3. Merge upstream/master with ours strategy (-X ours prefers Viraforge content on
#    content conflicts).  git merge exits 0 even when structural conflicts require
#    resolution, leaving the working tree in a conflicted state.
# 4. Programmatically resolve all remaining conflicts:
#    - content conflicts  → prefer Viraforge (--ours) — handled by -X ours
#    - modify/delete     → delete the file (ours wins: Viraforge deleted it)
#    - rename/delete     → keep file deleted (ours wins: Viraforge deleted it)
#    - add/add conflicts → accept upstream version (ours already has file)
# 5. Commit and push
# 6. Restore .env.example

git checkout -B "$INTEGRATION_BRANCH" "origin/$BASE_BRANCH"

have_env_backup=false
if [ -f .env.example ]; then
  cp .env.example "$SUMMARY_FILE.env.bak"
  have_env_backup=true
fi

if ! git merge -X ours "upstream/$BASE_BRANCH" 2>&1; then
  echo "Merge completed with structural conflicts; auto-resolving..." >&2
fi

# Resolve modify/delete conflicts:
# File deleted in ours (Viraforge) but modified in upstream.
# Keep the file deleted — accept the Viraforge deletion.
for f in $(git ls-files -u | awk '$2 != $3 && !seen[$4]++ {print $4}'); do
  git rm --cached "$f" 2>/dev/null || true
  rm -f "$f"
  git add "$f"
  echo "Resolved modify/delete: keeping deletion of $f"
done

# Check remaining unresolvable conflicts.
remaining=$(git ls-files -u | awk '{print $4}' | sort -u | grep -v '^$' | wc -l | tr -d ' ')
if [ "${remaining:-0}" -gt 0 ]; then
  echo "MERGE_CONFLICT: ${remaining} unresolvable conflicts — manual resolution required" >&2
  if [ "$have_env_backup" = true ]; then
    cp "$SUMMARY_FILE.env.bak" .env.example && rm "$SUMMARY_FILE.env.bak"
  fi
  git merge --abort 2>/dev/null || true

  # For genuine upstream changes with conflicts, require manual resolution
  cat > "$SUMMARY_FILE" <<EOF
## Upstream Sync $(date +%Y-%m-%d)

Sync failed: ${remaining} unresolvable merge conflicts between \`origin/$BASE_BRANCH\` and \`upstream/$BASE_BRANCH\`.
Upstream has new commits that require manual resolution.

**Manual intervention required.** Please resolve conflicts in \`$INTEGRATION_BRANCH\` and push.
EOF
  exit 0
fi

# All conflicts resolved — commit the merge.
COMMIT_MSG="Merge upstream/master into integration/upstream-sync"
if ! git commit -am "$COMMIT_MSG" 2>&1; then
  if git log --oneline -1 | grep -q "Merge upstream/master"; then
    echo "Merge already committed." >&2
  else
    echo "MERGE_CONFLICT: failed to commit merge" >&2
    if [ "$have_env_backup" = true ]; then
      cp "$SUMMARY_FILE.env.bak" .env.example && rm "$SUMMARY_FILE.env.bak"
    fi
    git merge --abort 2>/dev/null || true
    exit 1
  fi
fi

if [ "$have_env_backup" = true ]; then
  cp "$SUMMARY_FILE.env.bak" .env.example && rm "$SUMMARY_FILE.env.bak"
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
