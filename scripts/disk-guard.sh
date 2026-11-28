#!/usr/bin/env bash
# disk-guard.sh — disk-pressure guard for the /paperclip Longhorn PVC.
#
# Background: agents on this volume died with `ENOSPC: no space left on
# device, write`. The volume has since been grown in place 20G -> 197G
# (`df -h`; 196.7 GiB) across 2026-09-27/28 under the same PVC
# `pvc-16b1231a-b6f0-4293-b8c1-08d3974be5a8` (CON-211). Headroom is no longer
# the problem, but it will erode again, so this guard exists to report pressure
# deterministically *before* free space hits zero, making the condition visible
# instead of surfacing as a dead agent.
#
# Source of truth for the guard deployed on this volume. The repo copy is
# canonical; the two runtime copies at /paperclip/bin/disk-guard.sh and
# /paperclip/disk-guard.sh are deployed from it and must stay byte-identical.
# scripts/disk-guard.test.mjs pins the safety properties below, so run
# `node --test scripts/disk-guard.test.mjs` after any edit here.
#
# Safety rules baked in from measured behaviour on this volume:
#   * .local/share/opencode/opencode.db-wal  — live SQLite WAL. Deleting it
#     corrupts the DB. NEVER unlink. Only checkpoint via sqlite if asked.
#   * .local/share/pnpm/store                — 31261 of 31417 inodes are
#     hardlinked into node_modules, so it LOOKS like 581M but is almost
#     entirely un-reclaimable. Purging it frees ~15M and breaks hardlink dedup.
#   * instances/ and wt/                     — live agent homes and git worktrees
#     on open branches. Deleting loses uncommitted work.
#   * .nix-portable, .local/share/nix, .rustup — live toolchains; nix GC needs
#     proot and is not safe to run unsupervised from a live pod.
#
# Everything in safe_caches/ is regenerable from the network. Reclaim is
# verified per-path by counting only nlink==1 inodes, so a path that has been
# hardlinked into a live tree is skipped rather than deleted.
#
# Usage:
#   disk-guard.sh --check     report only; exit 2 at WARN, 3 at CRIT
#   disk-guard.sh --prune     prune the verified-safe set, then report.
#                             No-op unless level is warn/critical; force with
#                             DISK_GUARD_FORCE=1.
#   disk-guard.sh --status    print last recorded status (no measurement)
#
# Thresholds are volume-relative: percentages are absolute, but the free-space
# floor is max(MIN_FREE_MB, 3% of total) so it stays correct after a resize.
# Set DISK_GUARD_MIN_FREE_MB=0 to disable the floor entirely.
#
# Exit codes: 0 ok, 1 usage error, 2 warn, 3 critical. Exit 1 also covers a
# failed measurement: if df cannot be read we cannot know the level, and the
# guard reports that rather than guessing a level it did not measure.
#
# Requires bash (shebang above), not POSIX sh: it uses `local`, a here-string,
# and two arrays. Keep it that way -- do not "simplify" it to sh.

set -uo pipefail

MOUNT="${DISK_GUARD_MOUNT:-/paperclip}"
WARN_PCT="${DISK_GUARD_WARN_PCT:-88}"
CRIT_PCT="${DISK_GUARD_CRIT_PCT:-94}"
MIN_FREE_MB="${DISK_GUARD_MIN_FREE_MB:-1500}"
STATUS_FILE="${DISK_GUARD_STATUS_FILE:-/paperclip/run/disk-guard.status}"
API_URL="${PAPERCLIP_API_URL:-http://127.0.0.1:3100}"
WORKSPACES_DIR="${DISK_GUARD_WORKSPACES_DIR:-$MOUNT/instances/default/workspaces}"
WORKSPACE_RECLAIM_MIN_AGE_HOURS="${DISK_GUARD_WORKSPACE_RECLAIM_MIN_AGE_HOURS:-24}"
CARGO_TARGET_SHARED_DIR="${DISK_GUARD_CARGO_TARGET_SHARED_DIR:-$MOUNT/cargo-target-shared}"
CARGO_TARGET_RECLAIM_MIN_AGE_HOURS="${DISK_GUARD_CARGO_TARGET_RECLAIM_MIN_AGE_HOURS:-24}"
# In-band ownership marker each shared cargo target dir must carry to be
# reclaimable. The dir name alone is a human-typed label, not proof of who owns
# the build output inside it.
CARGO_TARGET_OWNER_MARKER="${DISK_GUARD_CARGO_TARGET_OWNER_MARKER:-.paperclip-owner}"

mode="${1:---check}"

# Pruned only when the path is missing or contains no hardlinked inodes,
# so we never delete an inode another tree still depends on.
safe_caches=(
  "$MOUNT/.cache/node"
  "$MOUNT/.cache/zig"
  "$MOUNT/.cache/opencode"
  "$MOUNT/.cache/pnpm"
  "$MOUNT/.cache/ms-playwright"
  "$MOUNT/.npm/_cacache"
  "$MOUNT/.npm/_npx"
)

# Rotated logs only; never the live WAL, never opencode.db.
log_dirs=(
  "$MOUNT/.local/share/opencode/log"
)

log() { printf '%s\n' "$*" >&2; }

# Company whose issue API decides terminality. There is deliberately NO
# hardcoded fallback here. This guard previously fell back to a *different*
# company's id, so any invocation without PAPERCLIP_COMPANY_ID in the
# environment (cron, systemd, a bare shell) queried the wrong tenant, got a
# 403, and silently reclaimed nothing while still reporting a healthy level.
# A missing company id must be a loud configuration error, never a silent
# wrong-tenant lookup that degrades to "no reclaim" invisibly.
#
# Only --prune consults the issue API. --check and --status are the monitoring
# surface and must keep working with no company id at all: a guard that cannot
# measure pressure is worse than one that cannot reclaim, because the failure
# is invisible until the volume is already full.
require_company_id() {
  if [ -n "${DISK_GUARD_COMPANY_ID:-}" ]; then
    COMPANY_ID="$DISK_GUARD_COMPANY_ID"
  elif [ -n "${PAPERCLIP_COMPANY_ID:-}" ]; then
    COMPANY_ID="$PAPERCLIP_COMPANY_ID"
  else
    log "no company id: set DISK_GUARD_COMPANY_ID or PAPERCLIP_COMPANY_ID"
    exit 1
  fi
}

remove_path() {
  local p="$1"
  if [ "${DISK_GUARD_DRY_RUN:-0}" = "1" ]; then
    log "dry-run rm -rf $p"
    return 0
  fi
  rm -rf -- "$p" 2>/dev/null
}

api_get() {
  local path="$1"
  if [ -n "${DISK_GUARD_API_STUB:-}" ]; then
    "$DISK_GUARD_API_STUB" "$path"
    return $?
  fi
  [ -n "${PAPERCLIP_API_KEY:-}" ] || return 1
  curl -fsS \
    -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
    -H "X-Paperclip-Run-Id: ${PAPERCLIP_RUN_ID:-disk-guard}" \
    "${API_URL%/}/api$path"
}

json_agent_ids() {
  node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(0,"utf8")); for (const a of (Array.isArray(data)?data:data.items??[])) if (a&&a.id) console.log(a.id);'
}

json_issue_status() {
  node -e 'const fs=require("fs"); const want=process.argv[1]; const data=JSON.parse(fs.readFileSync(0,"utf8")); const items=Array.isArray(data)?data:data.items??[data.issue??data]; const issue=items.find((item)=>item&&String(item.identifier||"").toUpperCase()===want.toUpperCase()); if (issue&&issue.status) console.log(issue.status);' "$1"
}

unlinked_bytes() {
  # Bytes held by inodes with nlink==1 under $1. This is the only figure that
  # predicts space actually returned to the filesystem.
  find "$1" -xdev -type f -links 1 -printf '%s\n' 2>/dev/null | awk '{s+=$1} END{print s+0}'
}

newest_mtime_epoch() {
  find "$1" -xdev -printf '%T@\n' 2>/dev/null | sort -nr | awk 'NR==1{printf "%d\n", $1; exit}'
}

candidate_issue_identifier() {
  local checkout="$1" branch identifier
  branch="$(git -C "$checkout" branch --show-current 2>/dev/null || true)"
  identifier="$(printf '%s\n' "$branch" | sed -nE 's/.*\b([A-Za-z]+-[0-9]+)\b.*/\U\1/p' | head -1)"
  [ -n "$identifier" ] && printf '%s\n' "$identifier"
}

issue_is_terminal() {
  local identifier="$1" status
  [ -n "$identifier" ] || return 1
  status="$(api_get "/companies/$COMPANY_ID/issues?q=$identifier&limit=10" 2>/dev/null | json_issue_status "$identifier" 2>/dev/null || true)"
  [ "$status" = "done" ] || [ "$status" = "cancelled" ]
}

contained_realpath() {
  local base="$1" target="$2" base_real target_real
  base_real="$(realpath -e -- "$base" 2>/dev/null)" || return 1
  target_real="$(realpath -e -- "$target" 2>/dev/null)" || return 1
  case "$target_real" in
    "$base_real"/*) printf '%s\n' "$target_real" ;;
    *) return 1 ;;
  esac
}

workspace_reclaim_candidates() {
  local agents_json agent_id workspace checkout rel p p_real identifier newest cutoff tracked
  [ -d "$WORKSPACES_DIR" ] || return 0
  agents_json="$(api_get "/companies/$COMPANY_ID/agents" 2>/dev/null)" || return 0
  cutoff=$(( $(date +%s) - WORKSPACE_RECLAIM_MIN_AGE_HOURS * 3600 ))
  while IFS= read -r agent_id; do
    workspace="$WORKSPACES_DIR/$agent_id"
    [ -d "$workspace" ] || continue
    for checkout in "$workspace"/* "$workspace"/*/.paperclip/worktrees/*; do
      [ -e "$checkout" ] || continue
      [ -d "$checkout/.git" ] || [ -f "$checkout/.git" ] || continue
      identifier="$(candidate_issue_identifier "$checkout")"
      if ! issue_is_terminal "$identifier"; then
        for rel in client/target target node_modules; do
          [ -e "$checkout/$rel" ] && log "skip  $checkout/$rel (issue ${identifier:-unknown} is not terminal)"
        done
        continue
      fi
      for rel in client/target target node_modules; do
        p="$checkout/$rel"
        [ -e "$p" ] || continue
        if [ -L "$p" ]; then
          log "skip  $p (candidate is a symlink)"
          continue
        fi
        p_real="$(contained_realpath "$workspace" "$p")" || {
          log "skip  $p (outside rostered workspace)"
          continue
        }
        if ! git -C "$checkout" check-ignore -q -- "$rel"; then
          log "skip  $p (not gitignored)"
          continue
        fi
        tracked="$(git -C "$checkout" ls-files -- "$rel" 2>/dev/null | wc -l | tr -d ' ')"
        if [ "${tracked:-0}" -ne 0 ]; then
          log "skip  $p (contains tracked files)"
          continue
        fi
        newest="$(newest_mtime_epoch "$p")"
        if [ -z "$newest" ] || [ "$newest" -ge "$cutoff" ]; then
          log "skip  $p (newest mtime under ${WORKSPACE_RECLAIM_MIN_AGE_HOURS}h)"
          continue
        fi
        printf '%s\n' "$p_real"
      done
    done
  done <<<"$(printf '%s' "$agents_json" | json_agent_ids)"
}

cargo_target_reclaim_candidates() {
  local p p_real name identifier marked newest cutoff
  [ -d "$CARGO_TARGET_SHARED_DIR" ] || return 0
  cutoff=$(( $(date +%s) - CARGO_TARGET_RECLAIM_MIN_AGE_HOURS * 3600 ))
  for p in "$CARGO_TARGET_SHARED_DIR"/*; do
    [ -d "$p" ] || continue
    [ ! -L "$p" ] || { log "skip  $p (candidate is a symlink)"; continue; }
    name="$(basename -- "$p")"
    identifier="$(printf '%s\n' "$name" | sed -nE 's/^([A-Za-z]+)-([0-9]+)$/\U\1-\2/p')"
    if [ -z "$identifier" ]; then
      log "skip  $p (not a per-issue target dir)"
      continue
    fi
    # A directory name is a label a person or agent typed, not evidence of who
    # owns the build output inside it. `def-190/` can hold another issue's
    # artifacts, and this volume already holds `def-129-base/` and
    # `def-129-cold/` beside `def-129/`. Deleting on the name alone removes
    # output the name does not describe, so require an in-band marker written by
    # whoever populated the directory and require it to agree with the name. A
    # dir with no marker is skipped: fail closed, and leave the space for a
    # human to attribute.
    if [ ! -f "$p/$CARGO_TARGET_OWNER_MARKER" ] || [ -L "$p/$CARGO_TARGET_OWNER_MARKER" ]; then
      log "skip  $p (no $CARGO_TARGET_OWNER_MARKER ownership marker)"
      continue
    fi
    marked="$(tr -d '[:space:]' <"$p/$CARGO_TARGET_OWNER_MARKER" 2>/dev/null || true)"
    if [ "$(printf '%s\n' "$marked" | tr '[:lower:]' '[:upper:]')" != "$identifier" ]; then
      log "skip  $p (marker says '${marked:-<empty>}', dir says '$identifier')"
      continue
    fi
    if ! issue_is_terminal "$identifier"; then
      log "skip  $p (issue $identifier is not terminal)"
      continue
    fi
    p_real="$(contained_realpath "$CARGO_TARGET_SHARED_DIR" "$p")" || {
      log "skip  $p (outside cargo-target-shared)"
      continue
    }
    newest="$(newest_mtime_epoch "$p")"
    if [ -z "$newest" ] || [ "$newest" -ge "$cutoff" ]; then
      log "skip  $p (newest mtime under ${CARGO_TARGET_RECLAIM_MIN_AGE_HOURS}h)"
      continue
    fi
    printf '%s\n' "$p_real"
  done
}

measure() {
  # df -P columns: 1=filesystem 2=size 3=used 4=avail 5=capacity 6=mount
  # Use awk so column positions and the percentage are explicit rather than
  # depending on locale, field wrapping, or bash having a ternary operator.
  df --block-size=1 -P "$MOUNT" 2>/dev/null | awk '
    NR>1 && NF>=5 {
      size=$2+0; used=$3+0; avail=$4+0
      printf "%d %d %d %d\n", size, used, avail, (size>0 ? int(used*100/size) : 0)
    }' | tail -1
}

report() {
  local size used avail pct avail_mb level rc floor_mb
  read -r size used avail pct <<<"$(measure)"

  # An unreadable or unparseable df is a measurement failure, not a pressure
  # signal. Without this guard the empty fields fall through the integer
  # comparisons below, which emit "integer expression expected" on stderr and
  # then return whatever the leftover status happens to be -- silently reporting
  # level=ok (and writing it to the durable status file) for a volume we could
  # not actually measure. rc=1 is the documented usage/measurement error.
  if [ -z "$size" ] || [ -z "$used" ] || [ -z "$avail" ] || [ -z "$pct" ]; then
    log "cannot measure $MOUNT (df returned no usable row); treating as a measurement error"
    return 1
  fi

  avail_mb=$(( avail / 1024 / 1024 ))

  # Free-space floor scales with the volume: a fixed 1500MiB floor meant
  # something different on a 20G volume than on a 59G one. 3% of total keeps
  # the guard's real intent (never run on a sliver) correct across resizes.
  # MIN_FREE_MB<=0 disables the floor, leaving percentage as the only signal.
  if [ "$MIN_FREE_MB" -le 0 ]; then
    floor_mb=0
  else
    floor_mb=$(( size * 3 / 100 / 1024 / 1024 ))
    [ "$floor_mb" -lt "$MIN_FREE_MB" ] && floor_mb=$MIN_FREE_MB
  fi

  level="ok"; rc=0
  if   [ "$pct" -ge "$CRIT_PCT" ]; then level="critical"; rc=3
  elif [ "$pct" -ge "$WARN_PCT" ] || [ "$avail_mb" -lt "$floor_mb" ]; then level="warn"; rc=2
  fi

  printf 'mount=%s size=%sGiB used=%sGiB(>%s%%) free=%sMiB floor=%sMiB level=%s\n' \
    "$MOUNT" "$(( size / 1024 / 1024 / 1024 ))" \
    "$(( used / 1024 / 1024 / 1024 ))" "$pct" "$avail_mb" "$floor_mb" "$level"

  # Durable, parseable state so a monitor/routine can read it without df.
  mkdir -p "$(dirname "$STATUS_FILE")" 2>/dev/null
  {
    printf 'checked_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'mount=%s\n' "$MOUNT"
    printf 'size_bytes=%s\nused_bytes=%s\navail_bytes=%s\nuse_pct=%s\navail_mb=%s\nfloor_mb=%s\n' \
      "$size" "$used" "$avail" "$pct" "$avail_mb" "$floor_mb"
    printf 'level=%s\nwarn_pct=%s\ncrit_pct=%s\nmin_free_mb=%s\n' \
      "$level" "$WARN_PCT" "$CRIT_PCT" "$MIN_FREE_MB"
    printf 'guard_version=3\n'
  } >"$STATUS_FILE" 2>/dev/null

  return "$rc"
}

prune() {
  local before after p freed total=0
  local lvl="" rc report_output
  local workspace_candidates=()
  local cargo_target_candidates=()
  # Everything below this point consults the issue API, so the company id must
  # resolve before any reclaim work starts.
  require_company_id
  # Pruning is a pressure response, not a scheduled chore. At 35% usage there
  # is nothing to fix, and deleting a 917MiB regenerable browser cache
  # "because the routine ran" costs a slow re-download for no gain. Only prune
  # when the volume is actually warn/critical, unless forced.
  #
  # The level must come from *this* run's measurement. report() returns 1 when
  # df is unusable and bails before writing the status file, so the file would
  # still hold a level from an earlier run -- and pruning on that stale reading
  # would delete caches without having measured anything. Fail closed.
  #
  # Only rc=1 counts as a measurement failure. report() also returns 2 (warn)
  # and 3 (critical) for successful measurements, so test the code exactly
  # rather than treating any non-zero status as an error.
  report_output="$(report 2>/dev/null)"
  rc=$?
  if [ "$rc" -eq 1 ]; then
    printf 'prune_skipped=measurement_failed\n'
    return 1
  fi
  case "$rc" in
    2) lvl="warn" ;;
    3) lvl="critical" ;;
    *) lvl="ok" ;;
  esac
  if [ "$lvl" != "warn" ] && [ "$lvl" != "critical" ] && [ "${DISK_GUARD_FORCE:-0}" != "1" ]; then
    printf 'prune_skipped=level_%s\n' "$lvl"
    return 0
  fi

  before="$(df --block-size=1 -P "$MOUNT" | awk 'NR>1 && NF>=5 {print $4; exit}')"

  for p in "${safe_caches[@]}"; do
    [ -e "$p" ] || continue
    freed="$(unlinked_bytes "$p")"
    if [ "$freed" -lt 1048576 ]; then
      # Either tiny, or made of hardlinked inodes that still have live copies.
      log "skip  $p (only $((freed/1024))KiB unlinked-reclaimable)"
      continue
    fi
    remove_path "$p"
    log "prune $p (~$((freed/1024/1024))MiB reclaimable)"
    total=$(( total + freed ))
  done

  while IFS= read -r p; do
    [ -n "$p" ] && workspace_candidates+=("$p")
  done <<<"$(workspace_reclaim_candidates)"
  for p in "${workspace_candidates[@]}"; do
    [ -e "$p" ] || continue
    freed="$(unlinked_bytes "$p")"
    if [ "$freed" -lt 1048576 ]; then
      log "skip  $p (only $((freed/1024))KiB unlinked-reclaimable)"
      continue
    fi
    remove_path "$p"
    log "prune $p (~$((freed/1024/1024))MiB reclaimable workspace build output)"
    total=$(( total + freed ))
  done

  while IFS= read -r p; do
    [ -n "$p" ] && cargo_target_candidates+=("$p")
  done <<<"$(cargo_target_reclaim_candidates)"
  for p in "${cargo_target_candidates[@]}"; do
    [ -e "$p" ] || continue
    freed="$(unlinked_bytes "$p")"
    if [ "$freed" -lt 1048576 ]; then
      log "skip  $p (only $((freed/1024))KiB unlinked-reclaimable)"
      continue
    fi
    remove_path "$p"
    log "prune $p (~$((freed/1024/1024))MiB reclaimable cargo target)"
    total=$(( total + freed ))
  done

  for p in "${log_dirs[@]}"; do
    [ -d "$p" ] || continue
    find "$p" -xdev -type f -mtime +1 -delete 2>/dev/null
    log "prune $p (rotated logs, mtime>1d)"
  done

  sync
  after="$(df --block-size=1 -P "$MOUNT" | awk 'NR>1 && NF>=5 {print $4; exit}')"
  printf 'reclaimed_mib=%s\n' "$(( (after - before) / 1024 / 1024 ))"
}

case "$mode" in
  --check)
    report; exit $?
    ;;
  --prune)
    prune
    report; rc=$?
    # prune() already measured and wrote status; report() re-ran for the caller.
    exit $rc
    ;;
  --status)
    [ -f "$STATUS_FILE" ] && cat "$STATUS_FILE" || { log "no status file: $STATUS_FILE"; exit 1; }
    exit 0
    ;;
  *)
    log "usage: disk-guard.sh [--check|--prune|--status]"; exit 1
    ;;
esac
