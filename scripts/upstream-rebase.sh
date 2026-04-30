#!/usr/bin/env bash
# Pull in upstream Paperclip changes, rebasing our master onto them.
# Run weekly. Conflicts are typically in adapter-plugins.json (keep both).

set -euo pipefail

cd "$(dirname "$0")/.."

if ! git remote | grep -q '^upstream$'; then
  echo "Adding upstream remote..."
  git remote add upstream https://github.com/paperclipai/paperclip
fi

echo "Fetching upstream..."
git fetch upstream

echo "Current branch: $(git branch --show-current)"
read -rp "Rebase onto upstream/master? [y/N] " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }

git rebase upstream/master

echo "Rebase complete. Don't forget to: pnpm install && pnpm dev"
