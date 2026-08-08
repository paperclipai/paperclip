#!/bin/sh
# Gate WT1 — serving-tree / main-checkout discipline (TSMC-20263 / TSKB0405).
#
# Fail-closed pre-commit/pre-op guard:
#   1) Refuse commits whose work-tree toplevel is the serving tree (~/paperclip-deploy).
#   2) Refuse commits in the MAIN ~/paperclip checkout when HEAD != refs/heads/live.
#   3) Allow worktree feature-branch commits (git-dir != git-common-dir).
#
# Hooks are shared across worktrees via core.hooksPath=.githooks on the common git dir.
# Main-vs-worktree detection compares realpath(git-dir) vs realpath(git-common-dir).
#
# Optional overrides (tests / break-glass only — never use in normal agent work):
#   PAPERCLIP_WT1_MAIN_CHECKOUT   default: $HOME/paperclip
#   PAPERCLIP_WT1_SERVING_TREE    default: $HOME/paperclip-deploy
#   PAPERCLIP_WT1_SKIP=1          skip this guard entirely
#   PAPERCLIP_WT1_FORCE_TOPLEVEL  pretend show-toplevel is this path
#   PAPERCLIP_WT1_FORCE_GIT_DIR / PAPERCLIP_WT1_FORCE_GIT_COMMON_DIR
#   PAPERCLIP_WT1_FORCE_HEAD      pretend symbolic-ref HEAD is this ref
#
# Exit 0 = allow, 1 = block, 2 = usage/internal error.

set -eu

if [ "${PAPERCLIP_WT1_SKIP:-0}" = "1" ]; then
  echo "[wt1] SKIPPED via PAPERCLIP_WT1_SKIP=1"
  exit 0
fi

MAIN_CHECKOUT="${PAPERCLIP_WT1_MAIN_CHECKOUT:-${HOME}/paperclip}"
SERVING_TREE="${PAPERCLIP_WT1_SERVING_TREE:-${HOME}/paperclip-deploy}"

realpath_portable() {
  # Prefer realpath(1); fall back to python for macOS without GNU coreutils.
  if command -v realpath >/dev/null 2>&1; then
    realpath "$1"
  else
    python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"
  fi
}

if [ -n "${PAPERCLIP_WT1_FORCE_TOPLEVEL:-}" ]; then
  toplevel="${PAPERCLIP_WT1_FORCE_TOPLEVEL}"
else
  toplevel="$(git rev-parse --show-toplevel 2>/dev/null || true)"
fi
if [ -z "${toplevel}" ]; then
  echo "[wt1] ERROR: not inside a git work tree" >&2
  exit 2
fi
toplevel_real="$(realpath_portable "$toplevel")"
main_real="$(realpath_portable "$MAIN_CHECKOUT")"
serving_real="$(realpath_portable "$SERVING_TREE")"

# --- (1) Serving tree is read-only -------------------------------------------
# Match exact serving path and common sibling names (candidate / staging pins).
case "$toplevel_real" in
  "$serving_real"|"$serving_real"/*)
    echo "[wt1] REJECTED: commit targets the SERVING tree ($toplevel_real)." >&2
    echo "[wt1] ~/paperclip-deploy is READ-ONLY (Gate WT1 / TSKB0405)." >&2
    echo "[wt1] Inspect with: git -C \"$SERVING_TREE\" …" >&2
    echo "[wt1] Do all platform work in a worktree of $MAIN_CHECKOUT on branch live." >&2
    exit 1
    ;;
esac
# Basename heuristic for alternate pin paths (paperclip-deploy.candidate, etc.)
toplevel_base="$(basename "$toplevel_real")"
case "$toplevel_base" in
  paperclip-deploy|paperclip-deploy.*|paperclip-deploy-*)
    echo "[wt1] REJECTED: toplevel looks like a serving/deploy pin ($toplevel_real)." >&2
    echo "[wt1] Serving trees are READ-ONLY. Use a worktree of $MAIN_CHECKOUT instead." >&2
    exit 1
    ;;
esac

# --- (2) Main checkout must stay on live -------------------------------------
if [ -n "${PAPERCLIP_WT1_FORCE_GIT_DIR:-}" ]; then
  git_dir="${PAPERCLIP_WT1_FORCE_GIT_DIR}"
else
  git_dir="$(git rev-parse --git-dir)"
fi
if [ -n "${PAPERCLIP_WT1_FORCE_GIT_COMMON_DIR:-}" ]; then
  git_common="${PAPERCLIP_WT1_FORCE_GIT_COMMON_DIR}"
else
  git_common="$(git rev-parse --git-common-dir)"
fi
# Resolve relative git-dir paths against toplevel
case "$git_dir" in
  /*) ;;
  *) git_dir="$toplevel_real/$git_dir" ;;
esac
case "$git_common" in
  /*) ;;
  *) git_common="$toplevel_real/$git_common" ;;
esac
git_dir_real="$(realpath_portable "$git_dir")"
git_common_real="$(realpath_portable "$git_common")"

is_main_checkout=0
if [ "$git_dir_real" = "$git_common_real" ]; then
  is_main_checkout=1
fi

if [ "$is_main_checkout" -eq 1 ] && [ "$toplevel_real" = "$main_real" ]; then
  if [ -n "${PAPERCLIP_WT1_FORCE_HEAD:-}" ]; then
    head_ref="${PAPERCLIP_WT1_FORCE_HEAD}"
  else
    head_ref="$(git symbolic-ref -q HEAD 2>/dev/null || true)"
  fi
  if [ "$head_ref" != "refs/heads/live" ]; then
    echo "[wt1] REJECTED: main checkout $MAIN_CHECKOUT is not on branch live." >&2
    echo "[wt1] HEAD=$head_ref (expected refs/heads/live)." >&2
    echo "[wt1] Never switch the main checkout onto a feature branch (Gate WT1)." >&2
    echo "[wt1] Create a worktree: git worktree add <path> -b <branch> live" >&2
    exit 1
  fi
fi

echo "[wt1] OK (toplevel=$toplevel_real main_checkout=$is_main_checkout head_ok=1)"
exit 0
