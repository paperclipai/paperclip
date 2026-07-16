#!/usr/bin/env bash
set -euo pipefail

root=$(git rev-parse --show-toplevel)
guard="$root/scripts/verify-git-attribution.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

git -C "$tmp" init -q
git -C "$tmp" config user.name 'Approved Human'
git -C "$tmp" config user.email 'approved@example.com'
cp "$guard" "$tmp/verify-git-attribution.sh"
chmod +x "$tmp/verify-git-attribution.sh"

(
  cd "$tmp"
  ./verify-git-attribution.sh --current-identities
)

printf 'Normal repository maintenance.\n' > "$tmp/approved-message"
(
  cd "$tmp"
  ./verify-git-attribution.sh --message-file approved-message
)

printf 'Maintenance\n\nCo-Authored-By: Paperclip <noreply@paperclip.ing>\n' > "$tmp/forbidden-message"
if (
  cd "$tmp"
  ./verify-git-attribution.sh --message-file forbidden-message
); then
  printf 'ERROR: forbidden attribution fixture unexpectedly passed\n' >&2
  exit 1
fi

if (
  cd "$tmp"
  GIT_AUTHOR_NAME=Paperclip GIT_AUTHOR_EMAIL=noreply@paperclip.ing \
    ./verify-git-attribution.sh --current-identities
); then
  printf 'ERROR: forbidden author fixture unexpectedly passed\n' >&2
  exit 1
fi

printf 'Git attribution guard fixtures passed; no forbidden commit was created.\n'
