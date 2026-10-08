#!/usr/bin/bash
# ──────────────────────────────────────────────────────────────────────────
# disk-pressure-gc.sh — HELA-9473: make farm GC track disk PRESSURE, not the clock.
#
# WHY THIS EXISTS (the HELA-9234 recurrence, root-caused 01.09):
#   9234 named the right eater and built the right tool (farm-artifact-gc.sh),
#   then scheduled it as `0 0 * * * STALE_DAYS=7`. That is a FIXED-WINDOW policy,
#   and it lost an arithmetic race it could never win:
#
#     measured fill rate    38G free 31.08 00:05Z -> 13G 01.09 00:10Z  = ~25 GB/day
#                           ...and 13G -> 0 bytes in the next 13 hours.
#     measured GC reach     STALE_DAYS=14 frees 5.8G of 36G (16%)
#                           STALE_DAYS=7  frees 11G  of 36G (30%)   [crontab note, 30.08]
#
#   So the 01.09 00:00 run DID fire, swept its 7-day slice, and still left the
#   box at 13G — because 70% of the farm was younger than the window. Twelve
#   hours later: ENOSPC, agents failing with no error (stdout could not be
#   written). A window longer than the fill time cannot hold the farm, and no
#   amount of re-running it on the same schedule changes that.
#
# THE FIX: tier STALE_DAYS to actual free space. Under pressure the window
#   tightens until it reaches artifacts young enough to matter. Healthy disk =
#   this exits in milliseconds, so it is cheap enough to run every 30 min
#   (a real sweep walks a 44G tree and takes ~10 min — far too heavy to run
#   unconditionally at that cadence; the df pre-check is what makes it viable).
#
# SAFETY: this script deletes NOTHING itself. Every removal goes through
#   farm-artifact-gc.sh, which owns the liveness guard (cwd+exe+fd over /proc),
#   the canonical-tree exclusion list, and the pre-delete race re-check. Adding a
#   second deletion path would mean a second place for those guards to rot.
#   STALE_DAYS=0 is the floor, NOT "delete everything": find -mtime +0 means
#   "modified more than 0 full days ago", so anything touched in the last 24h
#   still survives even at CRITICAL.
#   HELA-11412 (27.09) adds ONE more path, on purpose: the mtime window cannot
#   reach fresh full copies of .venv/node_modules (uv cache and pnpm store live
#   on /dev/sdb, so every worktree on / holds a copy) or clean checkouts of
#   closed cards. When / itself drops below STRICT_GB, closed-card-gc/disk_guard.py
#   runs its strictly guarded levers (each script owns its /proc liveness guard)
#   and signals HELA-12595. Healthy / skips it entirely.
#
#   HELA-12993 (29.09) adds the same strict tier for sdb (SDB_STRICT_GB, 12G) and an emergency tier for / below 5G
#   inside disk_guard.py (see its header).
#
# Test hooks:
#   FREE_GB_OVERRIDE=8 DRY_RUN=1 ./disk-pressure-gc.sh   # simulate CRITICAL, sweep nothing
#   DRY_RUN=1 ./disk-pressure-gc.sh                      # real df, dry-run sweep
#   ROOT_FREE_OVERRIDE=4 / SDB_FREE_OVERRIDE=7            # drive the strict tiers of / and sdb
# ──────────────────────────────────────────────────────────────────────────
set -uo pipefail
export PATH=/usr/bin:/bin

GC=/home/paperclip-user/bin/farm-artifact-gc.sh
LOG=${LOG:-/home/paperclip-user/farm-artifact-gc.log}
LOCK=/tmp/disk-pressure-gc.lock
DRY_RUN=${DRY_RUN:-0}

# Tier thresholds in GB of Avail on /. HEALTHY_GB is deliberately well above the
# 85% disk-alert line (~22G): by the time the alert fires we want the sweep to
# have already been running for hours, not to be starting from cold.
HEALTHY_GB=${HEALTHY_GB:-40}
ELEVATED_GB=${ELEVATED_GB:-25}
HIGH_GB=${HIGH_GB:-15}
CRIT_GB=${CRIT_GB:-10}

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] disk-pressure-gc: $*" >> "$LOG"; }

# Cap this log before writing to it. A disk GC whose own log is unbounded is a
# disk eater with extra steps: on 16.09 $LOG had reached 1.7 GB / 9.8M lines,
# because every sweep re-hit the same root-owned artifacts and copied rm's
# per-file "Permission denied" here, 30 minutes apart, for weeks (HELA-3914).
# farm-artifact-gc.sh now repairs that ownership and collapses a failure to one
# line, so this is the belt to that braces — the next unforeseen per-file error
# must not be able to fill the volume this script exists to protect.
# Truncate IN PLACE (never mv): cron's `>>` redirection and any in-flight sweep
# hold this path open in O_APPEND, and renaming it would leave them writing to
# an unlinked inode that no longer counts against, or frees, anything visible.
LOG_MAX_MB=${LOG_MAX_MB:-64}
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt $((LOG_MAX_MB * 1024 * 1024)) ]; then
  tail -n 2000 "$LOG" > "$LOG.keep" 2>/dev/null &&
    { truncate -s 0 "$LOG"; cat "$LOG.keep" >> "$LOG"; rm -f "$LOG.keep"; }
  log "rotated own log: exceeded ${LOG_MAX_MB}MB, kept last 2000 lines"
fi

# Never let two sweeps overlap — including with the 00:00 daily farm-artifact-gc
# run. Two concurrent rm -rf over the same tree race the liveness re-check.
exec 9>"$LOCK" || exit 0
flock -n 9 || { log "another sweep holds the lock, skipping"; exit 0; }

# Tier on the TIGHTEST volume that farm-artifact-gc.sh actually sweeps, not on `/`.
# HELA-9234 fixed precisely this bug in disk-alert.sh ("watched a single volume,
# literally df /, while /dev/sdb sat at 85% with NOBODY watching it") and this
# script shipped with the same defect: $ROOT/projects — one of the GC's four
# ROOTS — is mounted on /dev/sdb, which read 13G/87% on 01.09 while / read 46G.
# Tiering on / alone would leave the sweep asleep during sdb pressure. Volumes
# are DERIVED from ROOTS so a root added later is covered without editing this.
free_of() { df -BG --output=avail "$1" 2>/dev/null | tail -1 | tr -dc '0-9'; }
GC_ROOTS="/home/paperclip-user/.paperclip/instances/default/workspaces
/home/paperclip-user/.paperclip/instances/default/projects
/home/paperclip-user/helloprint-codex
/home/paperclip-user/helloprint"

if [ -n "${FREE_GB_OVERRIDE:-}" ]; then
  FREE_GB=$FREE_GB_OVERRIDE; TIGHTEST=override
else
  FREE_GB=""; TIGHTEST=""
  for r in $GC_ROOTS; do
    [ -d "$r" ] || continue
    f=$(free_of "$r"); [ -n "$f" ] || continue
    if [ -z "$FREE_GB" ] || [ "$f" -lt "$FREE_GB" ]; then
      FREE_GB=$f; TIGHTEST=$(df --output=source "$r" 2>/dev/null | tail -1)
    fi
  done
fi
if [ -z "$FREE_GB" ]; then
  log "could not read df for any GC root; farm sweep skipped, checking strict volumes"
  TIER=HEALTHY
elif [ "$FREE_GB" -lt "$CRIT_GB" ];     then TIER=CRITICAL; STALE=0
elif [ "$FREE_GB" -lt "$HIGH_GB" ];     then TIER=HIGH;     STALE=1
elif [ "$FREE_GB" -lt "$ELEVATED_GB" ]; then TIER=ELEVATED; STALE=3
elif [ "$FREE_GB" -lt "$HEALTHY_GB" ];  then TIER=ROUTINE;  STALE=7
else
  TIER=HEALTHY
fi

if [ "$TIER" != HEALTHY ]; then
  log "tier=$TIER free=${FREE_GB}G on ${TIGHTEST} (tightest GC-root volume) -> sweeping STALE_DAYS=$STALE"
fi

# HELA-11412: strict tier for / (see header). Runs under this script's flock
# (DISK_GUARD_LOCKED=1); tiers on / alone because every lever works on / only.
STRICT_GB=${STRICT_GB:-15}
ROOT_FREE=${ROOT_FREE_OVERRIDE:-$(free_of /)}
if [ -n "$ROOT_FREE" ] && [ "$ROOT_FREE" -lt "$STRICT_GB" ]; then
  log "strict tier: / free=${ROOT_FREE}G < ${STRICT_GB}G -> closed-card-gc/disk_guard.py"
  guard_args=(--threshold-gb "$STRICT_GB")
  [ -n "${ROOT_FREE_OVERRIDE:-}" ] && guard_args+=(--root-free-override "$ROOT_FREE_OVERRIDE")
  [ "$DRY_RUN" = 1 ] && guard_args+=(--dry-run)
  DISK_GUARD_LOCKED=1 timeout 3000 /usr/bin/python3 /opt/paperclip-cron/disk_guard_agent.py \
    "${guard_args[@]}" >> "$LOG" 2>&1 || log "strict tier: disk_guard.py exit $?"
fi

# HELA-12993 (29.09): strict tier for sdb. farm-artifact-gc.sh reaches neither of its two eaters (Codex session
# rollouts under companies/*/codex-home, the project farm at depth 5), so under sdb pressure the sweep below frees
# nothing there. disk_guard.py --volume sdb: archive rollouts idle 14 d -> 7 d, closed checkouts of the sdb farm
# idle 24 h; escalation on HELA-12595 below 8G with its own 2-hour timer. Test hook: SDB_FREE_OVERRIDE.
SDB_MNT=/mnt/HC_Volume_106646767
SDB_STRICT_GB=${SDB_STRICT_GB:-12}
SDB_FREE=${SDB_FREE_OVERRIDE:-$(free_of "$SDB_MNT")}
if [ -n "$SDB_FREE" ] && [ "$SDB_FREE" -lt "$SDB_STRICT_GB" ]; then
  log "strict tier sdb: ${SDB_MNT} free=${SDB_FREE}G < ${SDB_STRICT_GB}G -> closed-card-gc/disk_guard.py --volume sdb"
  sdb_args=(--volume sdb --threshold-gb "$SDB_STRICT_GB")
  [ -n "${SDB_FREE_OVERRIDE:-}" ] && sdb_args+=(--free-override "$SDB_FREE_OVERRIDE")
  [ "$DRY_RUN" = 1 ] && sdb_args+=(--dry-run)
  DISK_GUARD_LOCKED=1 timeout 3000 /usr/bin/python3 /opt/paperclip-cron/disk_guard_agent.py \
    "${sdb_args[@]}" >> "$LOG" 2>&1 || log "strict tier sdb: disk_guard.py exit $?"
fi

# Strict root/sdb cleanup is independent of the farm GC roots. A healthy farm
# tier must not skip pressure on a volume those roots do not cover.
[ "$TIER" != HEALTHY ] || exit 0

if [ "$DRY_RUN" = 1 ]; then
  log "DRY_RUN=1, would run: STALE_DAYS=$STALE $GC --apply"
  exit 0
fi

STALE_DAYS=$STALE "$GC" --apply >> "$LOG" 2>&1

# Re-measure the same way we measured going in (min across GC roots). Reading `/`
# here while having tiered on sdb would report a recovery that did not happen on
# the volume that triggered the sweep.
AFTER=""; AFTER_SOURCE=""
for r in $GC_ROOTS; do
  [ -d "$r" ] || continue
  f=$(free_of "$r"); [ -n "$f" ] || continue
  if [ -z "$AFTER" ] || [ "$f" -lt "$AFTER" ]; then
    AFTER=$f
    AFTER_SOURCE=$(df --output=source "$r" 2>/dev/null | tail -1)
    [ -n "$AFTER_SOURCE" ] || AFTER_SOURCE=$r
  fi
done
log "tier=$TIER done: ${FREE_GB}G -> ${AFTER:-?}G on ${AFTER_SOURCE:-?} (tightest GC-root volume)"

# CRITICAL that a sweep could not fix is the ENOSPC precursor from 01.09 and the
# one state a human must see. disk-alert.sh cannot report this: it is
# transition-based, so having already latched 'alert' at 85% on 31.08 15:00Z it
# stayed silent the whole way from 22G down to 0 bytes. This is the second alarm
# that stretch was missing.
if [ "$TIER" = CRITICAL ] && [ -n "$AFTER" ] && [ "$AFTER" -lt "$CRIT_GB" ]; then
  log "STILL CRITICAL after full sweep (${AFTER}G) — farm GC has no headroom left to reclaim"
  # Keep separate cooldowns for distinct farm volumes: pressure on sdb must
  # not be hidden by a recent root-volume alarm (or the reverse).
  volume_key=$(printf '%s' "$AFTER_SOURCE" | sha256sum | cut -c1-64)
  alarm_state=/home/paperclip-user/.disk-guard-state/last-critical-farm-alarm-$volume_key
  alarm_gap_s=7200
  last_alarm=$(cat "$alarm_state" 2>/dev/null || true)
  now_epoch=$(date +%s)
  if [[ $last_alarm =~ ^[0-9]+$ ]] && (( now_epoch >= last_alarm && now_epoch - last_alarm < alarm_gap_s )); then
    log "critical signal suppressed: previous farm alarm less than two hours ago"
  elif /usr/bin/python3 /opt/paperclip-cron/disk_client.py escalate; then
    if mkdir -p "$(dirname "$alarm_state")" && printf '%s\n' "$now_epoch" > "$alarm_state"; then
      log "critical signal sent through scoped reporter; next alarm after two hours"
    else
      log "critical signal sent, but cooldown state could not be saved"
    fi
  else
    log "critical signal rejected by scoped reporter"
  fi
fi
