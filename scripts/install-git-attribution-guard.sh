#!/usr/bin/env bash
set -euo pipefail

root=$(git rev-parse --show-toplevel)
git -C "$root" config --local core.hooksPath .githooks
chmod +x \
  "$root/.githooks/pre-commit" \
  "$root/.githooks/commit-msg" \
  "$root/.githooks/pre-push" \
  "$root/scripts/verify-git-attribution.sh"

printf 'Git attribution guard enabled through core.hooksPath=.githooks\n'
