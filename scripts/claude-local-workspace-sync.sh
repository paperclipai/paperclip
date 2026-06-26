#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  claude-local-workspace-sync.sh check --root ROOT --worker WORKER [--owner USER]
  claude-local-workspace-sync.sh sync  --root ROOT --worker WORKER [--owner USER]
  claude-local-workspace-sync.sh diff  --root ROOT --worker WORKER --patch PATCH [--owner USER]
  claude-local-workspace-sync.sh apply --root ROOT --worker WORKER --patch PATCH [--dry-run] [--owner USER]

Purpose:
  Safe v0 bridge for the non-root Claude lane:
    root repo -> worker-owned checkout -> reviewable patch -> explicit root apply.

Safety rules:
  - sync copies only git-tracked files from ROOT; untracked secrets are not copied.
  - diff excludes common secret/local-runtime paths and writes a patch artifact.
  - apply requires an explicit apply action and validates the patch before mutation.
  - apply --dry-run validates the patch against ROOT (git apply --check) and exits
    WITHOUT mutating ROOT; it is the reviewable boundary before a real apply.
EOF
}

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '[workspace-sync] %s\n' "$*"; }

ACTION="${1:-}"
[[ -n "$ACTION" ]] || { usage; exit 2; }
shift || true

ROOT=""
WORKER=""
OWNER=""
PATCH=""
DRY_RUN="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="${2:-}"; shift 2 ;;
    --worker) WORKER="${2:-}"; shift 2 ;;
    --owner) OWNER="${2:-}"; shift 2 ;;
    --patch) PATCH="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[[ "$ACTION" =~ ^(check|sync|diff|apply)$ ]] || fail "unknown action: $ACTION"
[[ -n "$ROOT" ]] || fail "--root is required"
[[ -n "$WORKER" ]] || fail "--worker is required"
ROOT="$(cd "$ROOT" && pwd -P)" || fail "root repo not found: $ROOT"
WORKER_PARENT="$(dirname "$WORKER")"
[[ -d "$WORKER_PARENT" ]] || fail "worker parent does not exist: $WORKER_PARENT"
WORKER_NAME="$(basename "$WORKER")"
WORKER="$(cd "$WORKER_PARENT" && pwd -P)/$WORKER_NAME"

[[ "$ROOT" == /root || "$ROOT" == /root/* ]] || info "root repo is not under /root; continuing with explicit --root=$ROOT"
[[ "$WORKER" != /root && "$WORKER" != /root/* ]] || fail "worker checkout must not be under /root: $WORKER"
[[ -d "$ROOT/.git" ]] || fail "root is not a git checkout: $ROOT"
[[ -d "$WORKER/.git" ]] || fail "worker is not a git checkout: $WORKER"

git_root() { git -c safe.directory="$ROOT" -C "$ROOT" "$@"; }
git_worker() { git -c safe.directory="$WORKER" -C "$WORKER" "$@"; }

if [[ -n "$OWNER" ]]; then
  [[ "$OWNER" =~ ^[a-z_][a-z0-9_-]*\$?$ ]] || fail "--owner must be a local POSIX account name"
  actual_owner="$(stat -c '%U' "$WORKER")"
  [[ "$actual_owner" == "$OWNER" ]] || fail "worker checkout owner is $actual_owner, expected $OWNER"
fi

case "$ACTION" in
  check)
    test -r "$ROOT/.git" || fail "root checkout is not readable"
    test -w "$WORKER" || fail "worker checkout is not writable by current user"
    info "check OK: root=$ROOT worker=$WORKER owner=$(stat -c '%U' "$WORKER")"
    ;;

  sync)
    tmp_files="$(mktemp)"
    trap 'rm -f "$tmp_files"' EXIT
    git_root ls-files -z > "$tmp_files"
    rsync_args=(-rlt --checksum --from0 --files-from="$tmp_files")
    if [[ -n "$OWNER" ]]; then
      owner_group="$(id -gn "$OWNER")"
      rsync_args+=(--chown="$OWNER:$owner_group")
    fi
    rsync "${rsync_args[@]}" "$ROOT/" "$WORKER/"
    # Treat the synced tracked files as the worker review baseline. This keeps a
    # later worker diff applyable to ROOT even when ROOT had uncommitted tracked
    # edits at sync time, while still avoiding any mutation of ROOT.
    git_worker add -u -- .
    info "synced git-tracked files from root to worker checkout"
    ;;

  diff)
    [[ -n "$PATCH" ]] || fail "--patch is required for diff"
    mkdir -p "$(dirname "$PATCH")"
    # Include untracked worker files as intent-to-add so they appear in review,
    # while excluding common local/secret/runtime material.
    mapfile -d '' untracked < <(git_worker ls-files -o --exclude-standard -z -- ':!*.env' ':!*.env.*' ':!.env' ':!.env.*' ':!**/.env' ':!**/.env.*' ':!node_modules/**' ':!dist/**' ':!data/**' ':!tmp/**' ':!.paperclip/**' ':!.claude/**' ':!.codex/**')
    if [[ ${#untracked[@]} -gt 0 ]]; then
      git_worker add -N -- "${untracked[@]}"
    fi
    git_worker diff --binary -- ':!*.env' ':!*.env.*' ':!.env' ':!.env.*' ':!**/.env' ':!**/.env.*' ':!node_modules/**' ':!dist/**' ':!data/**' ':!tmp/**' ':!.paperclip/**' ':!.claude/**' ':!.codex/**' > "$PATCH"
    bytes="$(wc -c < "$PATCH")"
    info "wrote patch artifact: $PATCH ($bytes bytes)"
    ;;

  apply)
    [[ -n "$PATCH" ]] || fail "--patch is required for apply"
    [[ -f "$PATCH" ]] || fail "patch not found: $PATCH"
    git_root apply --check "$PATCH"
    if [[ "$DRY_RUN" == "1" ]]; then
      info "dry-run OK: patch applies cleanly to root repo; ROOT not mutated ($PATCH)"
      exit 0
    fi
    git_root apply "$PATCH"
    info "applied patch to root repo after git apply --check"
    ;;
esac
