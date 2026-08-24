#!/usr/bin/env bash
# TSMC-21384 — install commit refuse hooks into the serving checkout.
# pinned-deploy-start / promote-pointer should call this so the guard survives
# tree swaps. Commits inside ~/paperclip-deploy create orphan objects the source
# repo never sees (cbae6c983 class).
set -euo pipefail
DEPLOY_ROOT="${1:-${PAPERCLIP_DEPLOY_ROOT:-$HOME/paperclip-deploy}}"
GIT_DIR="$DEPLOY_ROOT/.git"
if [ -f "$GIT_DIR" ]; then
  # worktree .git file form
  GIT_DIR="$(sed -n 's/^gitdir: //p' "$GIT_DIR")"
fi
[ -d "$GIT_DIR/hooks" ] || { echo "no hooks dir at $DEPLOY_ROOT" >&2; exit 1; }

HOOK_BODY='#!/usr/bin/env bash
# TSMC-21384: refuse commits inside the serving tree.
if [ "${PAPERCLIP_PINNED_DEPLOY_ALLOW_COMMIT:-0}" = "1" ]; then
  echo "[paperclip-deploy pre-commit] break-glass allow" >&2
  exit 0
fi
cat >&2 <<'"'"'MSG'"'"'
[paperclip-deploy commit-hook] REFUSED (TSMC-21384)

Commits inside the serving checkout are forbidden.
Land work on a source worktree, then promote via pinned-deploy-promote.sh.
Break-glass only: PAPERCLIP_PINNED_DEPLOY_ALLOW_COMMIT=1
MSG
exit 1
'
for name in pre-commit commit-msg; do
  path="$GIT_DIR/hooks/$name"
  printf '%s\n' "$HOOK_BODY" > "$path"
  chmod +x "$path"
  echo "installed $path"
done
