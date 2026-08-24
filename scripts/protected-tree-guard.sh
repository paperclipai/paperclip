#!/usr/bin/env bash
# Protected-tree guard (TSMC-21348).
#
# On 2026-08-23 an engineer lane wrote 556 lines into /Users/glad0s/paperclip —
# the serving source tree and the git source of truth for `live` — including
# work-products. Its workspace was configured CORRECTLY (a separate managed
# directory, verified not a symlink); the agent simply wrote absolute paths
# outside it. So workspace MODE is not the control: `isolated_workspace` would
# not have prevented it.
#
# The paperclip skill already says "Work only in the assigned filesystem scope".
# That is instruction, not enforcement — and `localProcessSandbox` is configured
# on exactly zero hermes lanes.
#
# Real enforcement (a sandbox) is a bigger piece of work and risky on macOS,
# which has no bwrap. This is the cheap half that was actually missing: NOTICING.
# Today the condition was discovered only because a `git merge --ff-only` into
# live refused — a careless stash or reset at that moment would have destroyed
# an engineer lane's in-flight task.
#
# Reports; does not block. Exit 2 when a protected tree is dirty.
set -uo pipefail

# Trees no agent should be writing into.
PROTECTED_TREES="${PAPERCLIP_PROTECTED_TREES:-$HOME/paperclip $HOME/paperclip-deploy}"
DB_URL="${PAPERCLIP_GUARD_DB_URL:-postgres://paperclip:paperclip@127.0.0.1:54329/paperclip}"

log() { echo "[protected-tree-guard $(date '+%H:%M:%S')] $*"; }

dirty_found=0
for tree in $PROTECTED_TREES; do
  [ -d "$tree/.git" ] || continue
  # Ignore untracked build noise; tracked modifications are the signal.
  dirty="$(git -C "$tree" status --porcelain --untracked-files=no 2>/dev/null || true)"
  [ -n "$dirty" ] || { log "clean: $tree"; continue; }
  dirty_found=1
  count="$(printf '%s\n' "$dirty" | wc -l | tr -d ' ')"
  log "DIRTY: $tree — $count tracked path(s) modified outside any agent workspace"
  printf '%s\n' "$dirty" | head -20 | sed 's/^/    /'
  [ "$count" -gt 20 ] && echo "    ... and $((count - 20)) more"

  # Name the lanes that were running while those files were last written, so the
  # report points at a suspect instead of just a symptom. Read-only.
  newest="$(printf '%s\n' "$dirty" | awk '{print $NF}' \
    | while IFS= read -r f; do
        [ -f "$tree/$f" ] && stat -f '%m %N' "$tree/$f" 2>/dev/null
      done | sort -rn | head -1 | awk '{print $1}')"
  if [ -n "$newest" ] && command -v psql >/dev/null 2>&1; then
    log "most recent write: $(date -r "$newest" '+%Y-%m-%d %H:%M:%S') — lanes running then:"
    PGPASSWORD=paperclip psql "$DB_URL" -At -F' | ' -c "
      SELECT a.name, a.adapter_type, to_char(r.started_at,'HH24:MI:SS')
      FROM heartbeat_runs r JOIN agents a ON a.id=r.agent_id
      WHERE r.started_at <= to_timestamp($newest)
        AND (r.finished_at IS NULL OR r.finished_at >= to_timestamp($newest) - interval '2 minutes')
      ORDER BY r.started_at DESC LIMIT 5;" 2>/dev/null | sed 's/^/    /' || true
  fi
done

# TSMC-21384: serving HEAD must be an object the source repo knows.
# Commits made only inside ~/paperclip-deploy (cbae6c983 class) pass a clean
# porcelain check but are silently discarded by prepare-candidate.
orphan_found=0
SOURCE_ROOT="${PAPERCLIP_SOURCE_ROOT:-$HOME/paperclip}"
DEPLOY_ROOT_CHECK="${PAPERCLIP_DEPLOY_ROOT:-$HOME/paperclip-deploy}"
if [ -d "$DEPLOY_ROOT_CHECK/.git" ] || [ -f "$DEPLOY_ROOT_CHECK/.git" ]; then
  deploy_head="$(git -C "$DEPLOY_ROOT_CHECK" rev-parse HEAD 2>/dev/null || true)"
  if [ -n "$deploy_head" ]; then
    if git -C "$SOURCE_ROOT" cat-file -t "$deploy_head" >/dev/null 2>&1; then
      log "deploy HEAD source-reachable: ${deploy_head:0:9}"
    else
      orphan_found=1
      log "ORPHAN DEPLOY HEAD: $deploy_head is NOT in $SOURCE_ROOT (cbae6c983 class)"
      log "  restore: git -C $DEPLOY_ROOT_CHECK checkout -f <source-known-sha>"
      log "  recover commit first if it has unique work (format-patch -> source worktree)"
    fi
  fi
fi

if [ "$dirty_found" = "1" ] || [ "$orphan_found" = "1" ]; then
  if [ "$dirty_found" = "1" ]; then
    log "A protected tree has uncommitted agent work. Do NOT stash/reset blindly:"
    log "  1. identify the owning lane and its issue before touching anything;"
    log "  2. a merge into live will refuse while these paths are dirty — that refusal is the system working."
  fi
  exit 2
fi
log "all protected trees clean"
