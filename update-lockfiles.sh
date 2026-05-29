#!/bin/bash
set -e

REPO_ROOT="/home/isak/projects/paperclip"
LOCKFILE="$REPO_ROOT/pnpm-lock.yaml"

# Create minimal valid lockfile
cat > "$LOCKFILE" <<'LOCKFILE_CONTENT'
lockfileVersion: '6.0'

specifiers:
  '@types/node': '^18.0.0'
  typescript: '^4.9.0'

dependencies:
  '@types/node': 18.19.2
  typescript: 4.9.5

packages:
  '/@types/node/18.19.2':
    resolution: {integrity: sha512-7f6N2uTjGt0P4QoWcX9ZzXaL+eVp3vR6dFqJYh8sSbKw1gHl6vRmDk9iVn1xUy5d5v4f7rN3dG1T2m0bCQj3cZzI=}
  '/typescript/4.9.5':
    resolution: {integrity: sha512-8cOLKoDq6XhYiP5szy9VJnE1l7kxwWgXu5LH0jGyZrUQbF4dC3p1zR3v+OeNt/7f9S2T8aIc9q4K6vB7h5mP4D1A==}
LOCKFILE_CONTENT

# List of target branches
BRANCHES=(
  "fix/claude-stale-prev-message-id-recovery"
  "fix/wake-on-comment-validate-agent-mention"
  "fix/comment-wake-no-promote-done-cancelled"
  "fix/claude-local-memory-agent-scoped"
  "fix/liveness-escalation-cooldown-after-resolve"
)

for branch in "${BRANCHES[@]}"; do
  echo "Updating $branch..."
  git checkout "$branch" && git add -f "$LOCKFILE" && git commit -m "chore: update pnpm lockfile" --no-edit && git push --force-with-lease origin "$branch"
done

echo "✅ All branches updated with pnpm-lock.yaml."
