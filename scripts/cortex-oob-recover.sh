#!/usr/bin/env bash
# cortex-oob-recover.sh — out-of-band canary update-failure recovery entrypoint.
#
# NEO-532 (subtask 522f of NEO-522). The "recovery" half of Brian's out-of-band requirement: a
# HOST-LEVEL entrypoint that brings a failed canary (live orchestrator) update back online so work
# can continue. It is the ESCALATION after the deterministic auto-rollback in the weekly train
# (522d) has already failed or the failure is novel.
#
# --- Design principle 1: independent failure domain -------------------------------------------
# This runs at the HOST level with its own creds/context — NOT as a Paperclip heartbeat on the
# instance being updated. If the live orchestrator is down, an agent hosted *on it* can't recover
# it. So: (a) all the recovery context lives in a pre-primed handoff artifact on a stable host
# path (scripts/cortex-release-handoff.sh, written before the upgrade), and (b) this script reads
# only that artifact + host tools (git / systemctl / db:backup / curl) — it never calls back into
# the orchestrator's API. assert_independent() below enforces the artifact is outside the live tree.
#
# --- Design principle 2: deterministic restore first, agent second ----------------------------
# `--restore` is a deterministic, host-tools-only restore of the live tree to the handoff's
# last-known-good ref (checkout → rebuild → restart → health → content-verify). No LLM required —
# this is what the train auto-fires and what a human runs first. `--agent` launches a pre-primed
# Claude Code (or equivalent, via CORTEX_OOB_AGENT_CMD) pointed at the handoff for NOVEL failures
# the deterministic path can't fix. `--auto` (the train's escalation call) prefers the agent when
# one is wired, else falls back to the deterministic restore.
#
# Usage:
#   cortex-oob-recover.sh --restore [--handoff <dir|cut>]   # deterministic LKG restore (host tools only)
#   cortex-oob-recover.sh --agent   [--handoff <dir|cut>]   # launch pre-primed recovery agent
#   cortex-oob-recover.sh --auto    [--handoff <dir|cut>]   # agent if wired, else deterministic restore
#   cortex-oob-recover.sh --print   [--handoff <dir|cut>]   # show the resolved handoff + context
#   cortex-oob-recover.sh --dry-run --restore [--handoff …] # print the restore plan, change nothing
#   (--handoff defaults to $CORTEX_RELEASE_ROOT/latest)
#
# Exit: 0 = recovered green / plan printed / handoff shown; 1 = could not restore (ALERT emitted).

set -euo pipefail

# --- Config (env-overridable) -----------------------------------------------------------------
CORTEX_RELEASE_ROOT="${CORTEX_RELEASE_ROOT:-/var/lib/cortex-release}"
# Audit log — every recovery action is appended here AND to journald (when run under systemd).
CORTEX_OOB_LOG="${CORTEX_OOB_LOG:-/var/log/cortex-oob-recover.log}"
# The pre-primed recovery agent launcher, invoked as `$CMD <handoff-md> <context-env>`. Optional:
# with no agent wired, --agent explains how to launch one and --auto falls back to --restore.
CORTEX_OOB_AGENT_CMD="${CORTEX_OOB_AGENT_CMD:-}"

# Health-check tunables + injectable primitives. The primitives default to real host tools; they
# are overridable so the restore can be exercised end-to-end in tests without a live instance.
CORTEX_OOB_HEALTH_RETRIES="${CORTEX_OOB_HEALTH_RETRIES:-30}"
CORTEX_OOB_HEALTH_INTERVAL="${CORTEX_OOB_HEALTH_INTERVAL:-2}"
CORTEX_OOB_BUILD_CMD="${CORTEX_OOB_BUILD_CMD:-}"     # `$CMD <tree>`   (default: pnpm install+build)
CORTEX_OOB_RESTART_CMD="${CORTEX_OOB_RESTART_CMD:-}" # `$CMD <service>`(default: sudo systemctl restart)
CORTEX_OOB_HEALTH_CMD="${CORTEX_OOB_HEALTH_CMD:-}"   # `$CMD <url>`    (default: curl retry loop)
CORTEX_OOB_VERIFY_CMD="${CORTEX_OOB_VERIFY_CMD:-}"   # `$CMD <base> <config>` (default: verify-content.mjs)

MODE=""
DRY=0
HANDOFF_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --restore) MODE="restore"; shift ;;
    --agent)   MODE="agent";   shift ;;
    --auto)    MODE="auto";    shift ;;
    --print)   MODE="print";   shift ;;
    --dry-run) DRY=1; shift ;;
    --handoff) HANDOFF_ARG="${2:-}"; shift 2 ;;
    -h|--help) grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "cortex-oob-recover: unknown arg: $1" >&2; exit 2 ;;
  esac
done

_ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
_audit() { printf '%s %s\n' "$(_ts)" "$*" >>"$CORTEX_OOB_LOG" 2>/dev/null || true; }
log()   { printf '\033[1;32m[oob-recover]\033[0m %s\n' "$*" >&2; _audit "INFO $*"; }
warn()  { printf '\033[1;33m[oob-recover] WARN:\033[0m %s\n' "$*" >&2; _audit "WARN $*"; }
alert() { printf '\033[1;31m[oob-recover] ALERT:\033[0m %s\n' "$*" >&2; _audit "ALERT $*"; }
die()   { alert "$*"; exit 1; }

# --- Handoff resolution + context load --------------------------------------------------------
# Accept a dir, a cut id (resolved under CORTEX_RELEASE_ROOT), or nothing (→ latest symlink).
resolve_handoff_dir() {
  local arg="$1" dir
  if [[ -z "$arg" ]]; then dir="$CORTEX_RELEASE_ROOT/latest"
  elif [[ -d "$arg" ]]; then dir="$arg"
  else dir="$CORTEX_RELEASE_ROOT/$arg"; fi
  # Follow the latest symlink to a concrete dir for logging clarity.
  [[ -L "$dir" ]] && dir="$(readlink -f "$dir" 2>/dev/null || echo "$dir")"
  printf '%s' "$dir"
}

# Load context.env into the current shell. Only our own well-known keys, from a file we wrote.
load_context() {
  local dir="$1"
  [[ -d "$dir" ]] || die "handoff dir not found: $dir (has a cut been materialized? see cortex-release-handoff.sh)"
  [[ -r "$dir/context.env" ]] || die "handoff has no readable context.env: $dir"
  # shellcheck disable=SC1091
  set -a; . "$dir/context.env"; set +a
  HANDOFF_DIR="$dir"
}

# --- Independent-failure-domain guard ---------------------------------------------------------
# The artifact MUST be outside the live tree (else it's unreadable when the orchestrator's disk /
# tree is the thing that's broken, and it defeats the OOB premise). Refuse otherwise.
assert_independent() {
  local dir="$1"
  case "$dir/" in
    "$CORTEX_HANDOFF_LIVE_TREE"/*)
      die "handoff $dir lives INSIDE the live tree $CORTEX_HANDOFF_LIVE_TREE — that is not an independent failure domain; recovery context must be out-of-band." ;;
  esac
  # A recovery agent must never be a heartbeat on the instance it recovers. If we were launched
  # from inside a Paperclip heartbeat targeting this live instance, refuse (opt out with
  # CORTEX_OOB_ALLOW_HEARTBEAT=1 only for controlled tests).
  if [[ "${CORTEX_OOB_ALLOW_HEARTBEAT:-0}" != "1" && -n "${PAPERCLIP_RUN_ID:-}" ]]; then
    die "refusing to run inside a Paperclip heartbeat (PAPERCLIP_RUN_ID set) — the OOB recovery agent must run host-level, independent of the instance being updated."
  fi
  return 0
}

# --- Primitives (injectable) ------------------------------------------------------------------
oob_build() {
  local tree="$1"
  if [[ -n "$CORTEX_OOB_BUILD_CMD" ]]; then "$CORTEX_OOB_BUILD_CMD" "$tree"; return; fi
  ( cd "$tree"; unset NODE_ENV; pnpm install --frozen-lockfile && pnpm build )
}
oob_restart() {
  local svc="$1"
  if [[ -n "$CORTEX_OOB_RESTART_CMD" ]]; then "$CORTEX_OOB_RESTART_CMD" "$svc"; return; fi
  sudo systemctl restart "$svc"
}
oob_health() {
  local url="$1"
  if [[ -n "$CORTEX_OOB_HEALTH_CMD" ]]; then "$CORTEX_OOB_HEALTH_CMD" "$url"; return; fi
  local i
  for ((i = 1; i <= CORTEX_OOB_HEALTH_RETRIES; i++)); do
    curl -fsS --max-time 5 "$url" >/dev/null 2>&1 && return 0
    sleep "$CORTEX_OOB_HEALTH_INTERVAL"
  done
  return 1
}
oob_verify() {
  local base="$1" config="$2"
  if [[ -n "$CORTEX_OOB_VERIFY_CMD" ]]; then "$CORTEX_OOB_VERIFY_CMD" "$base" "$config"; return; fi
  # Reuse 522b's content-verify runner against the recovered instance.
  if ! compgen -G "$CORTEX_HANDOFF_BETA_TREE/release-probes/*.yaml" >/dev/null 2>&1 \
     && ! compgen -G "$CORTEX_HANDOFF_BETA_TREE/release-probes/*.yml" >/dev/null 2>&1; then
    log "no release-probes present — content-verify is a no-op"; return 0
  fi
  local pre=""; [[ -n "$config" ]] && pre="PAPERCLIP_CONFIG='$config' "
  eval "${pre}node '$CORTEX_HANDOFF_BETA_TREE/scripts/verify-content.mjs' --base '$base' --dir '$CORTEX_HANDOFF_BETA_TREE/release-probes'"
}

# --- Deterministic restore to last-known-good -------------------------------------------------
restore_to_lkg() {
  local ref="$CORTEX_HANDOFF_LKG" tree="$CORTEX_HANDOFF_LIVE_TREE" svc="$CORTEX_HANDOFF_LIVE_SERVICE"
  local health="$CORTEX_HANDOFF_LIVE_HEALTH_URL" base="$CORTEX_HANDOFF_LIVE_BASE_URL" cfg="$CORTEX_HANDOFF_LIVE_CONFIG"

  [[ -n "$ref" ]]  || die "handoff has no last-known-good ref (CORTEX_HANDOFF_LKG empty) — cannot deterministically restore; escalate to --agent."
  [[ -n "$tree" ]] || die "handoff has no live tree (CORTEX_HANDOFF_LIVE_TREE empty)."

  if [[ "$DRY" == "1" ]]; then
    log "DRY-RUN restore plan for cut ${CORTEX_HANDOFF_CUT}:"
    log "  1. git -C $tree checkout --force $ref"
    log "  2. rebuild ($tree): pnpm install --frozen-lockfile && pnpm build"
    log "  3. restart $svc"
    log "  4. health-gate $health"
    log "  5. content-verify $base"
    log "  DB: if a migration applied, restore backup ${CORTEX_HANDOFF_BACKUP:-<see context.env / db:backup --list>} per §2 (no db:restore CLI)."
    return 0
  fi

  git -C "$tree" cat-file -e "${ref}^{commit}" 2>/dev/null \
    || die "last-known-good ref ${ref:0:12} not present in live tree $tree — escalate to --agent (fetch $CORTEX_HANDOFF_LIVE_REMOTE or DB restore may be needed)."

  log "restore: checkout LKG ${ref:0:12} in $tree"
  git -C "$tree" checkout --force --quiet "$ref" || die "checkout of LKG ${ref:0:12} failed."
  log "restore: rebuild $tree"
  oob_build "$tree" || warn "rebuild reported issues (continuing to restart + health gate)"
  log "restore: restart $svc"
  oob_restart "$svc" || warn "restart reported issues (continuing to health gate)"
  log "restore: health gate $health"
  oob_health "$health" || die "live did not come healthy after restore to ${ref:0:12} — NOVEL failure; escalate to --agent and check journalctl -u $svc."
  log "restore: content-verify $base"
  oob_verify "$base" "$cfg" || die "content-verify still red after restore to ${ref:0:12} — escalate to --agent; a migration may need DB restore (§2)."

  # Code restore is green. If the failed promotion applied a migration, the code rollback did not
  # undo it — surface the DB restore rather than pretend it's fully handled.
  alert "DB RESTORE MAY BE REQUIRED: if the failed promotion applied a migration, restore the pre-promotion backup \"${CORTEX_HANDOFF_BACKUP:-<see $HANDOFF_DIR/context.env / db:backup --list>}\" per DEV-PROCESS §5.4 / NEO-198 (§2 of HANDOFF.md). Code restore alone does not undo an applied migration."
  log "restore COMPLETE: live is green on last-known-good ${ref:0:12} (cut ${CORTEX_HANDOFF_CUT})."
  return 0
}

# --- Launch the pre-primed recovery agent -----------------------------------------------------
launch_agent() {
  local md="$HANDOFF_DIR/HANDOFF.md"
  [[ -r "$md" ]] || die "handoff HANDOFF.md missing: $md"
  if [[ -z "$CORTEX_OOB_AGENT_CMD" ]]; then
    warn "no CORTEX_OOB_AGENT_CMD wired — cannot auto-launch a recovery agent."
    warn "Launch one manually, host-level, pointed at the handoff, e.g.:"
    warn "    claude --dangerously-skip-permissions -p \"You are the OOB recovery agent. Read $md and restore the live orchestrator to green, using only host tools. Start with: $CORTEX_HANDOFF_BETA_TREE/scripts/cortex-oob-recover.sh --restore --handoff $HANDOFF_DIR\""
    return 1
  fi
  log "launching pre-primed recovery agent for cut ${CORTEX_HANDOFF_CUT}: $CORTEX_OOB_AGENT_CMD"
  "$CORTEX_OOB_AGENT_CMD" "$md" "$HANDOFF_DIR/context.env"
}

# When sourced by tests (CORTEX_OOB_SOURCE_ONLY=1), expose functions without dispatching.
[[ "${CORTEX_OOB_SOURCE_ONLY:-}" == "1" ]] && return 0 2>/dev/null || true

# --- Dispatch ---------------------------------------------------------------------------------
[[ -n "$MODE" ]] || die "no mode given (--restore | --agent | --auto | --print). See --help."

HANDOFF_DIR="$(resolve_handoff_dir "$HANDOFF_ARG")"
load_context "$HANDOFF_DIR"
assert_independent "$HANDOFF_DIR"
log "resolved handoff: $HANDOFF_DIR (cut ${CORTEX_HANDOFF_CUT}, candidate ${CORTEX_HANDOFF_CANDIDATE:0:12}, lkg ${CORTEX_HANDOFF_LKG:0:12})"

case "$MODE" in
  print)
    printf -- '--- context.env ---\n' >&2; cat "$HANDOFF_DIR/context.env" >&2
    printf -- '\n--- HANDOFF.md ---\n' >&2; cat "$HANDOFF_DIR/HANDOFF.md" >&2
    ;;
  restore) restore_to_lkg ;;
  agent)   launch_agent ;;
  auto)
    if [[ -n "$CORTEX_OOB_AGENT_CMD" ]]; then
      log "escalation: recovery agent is wired — handing off to it (deterministic auto-rollback already failed)."
      launch_agent
    else
      log "escalation: no recovery agent wired — falling back to deterministic LKG restore."
      restore_to_lkg
    fi
    ;;
esac
