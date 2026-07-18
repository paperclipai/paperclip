#!/usr/bin/env bash
# cortex-weekly-train.sh — the weekly canary + fleet release train (§5-gated live promotion).
#
# NEO-529 (subtask 522d of NEO-522, the Cortex CI/CD weekly-release pipeline). This is the
# TOP of the pipeline chain. The release model (NEO-522 plan §2.0) is:
#
#   review continuously on beta  →  once a week, promote the approved+tested beta snapshot LIVE.
#
# Beta is deployed continuously + content-verified by the pull deploy agent (522a/NEO-526 +
# 522b/NEO-527). This train takes the green beta snapshot and, ONLY behind a final CTO
# release-approval, promotes it onto the live orchestrator via the governed DEV-PROCESS §5
# path (db:backup first), then cuts the stable fleet ring. Every stage is rollback-capable.
#
#   preflight (beta green?)  →  CTO approval GATE  →  canary (§5 → live)  →  fleet (stable cut + ring)
#
# Driven by cortex-weekly-train.timer/.service (systemd oneshot, weekly), so every run is
# journalctl-observable:  journalctl -u cortex-weekly-train -f
#
# --- Guardrails (Hard Rules) -------------------------------------------------------------
# * The live orchestrator is NEVER a direct build/migrate target. It changes ONLY through the
#   CTO-gated §5 promotion below, which takes a DB backup FIRST. Nothing here mutates live
#   until (a) beta is proven green AND (b) a CTO release-approval token matching THIS exact
#   snapshot exists. Absent the token, the run halts having changed nothing live.
# * Approval is snapshot-scoped and single-use: a token approves one specific beta commit SHA.
#   An approval for last week's snapshot can never silently promote a different one.
# * All DB ops go through the runtime CLI (Hard Rule #1): `paperclipai db:backup` /
#   `pnpm db:migrate`, never raw psql.
# * Each stage (canary, each fleet ring member) is independently rollback-capable: on any
#   failure it restores the pre-promotion code ref + DB backup, rebuilds, restarts, re-checks.
#
# Usage:
#   scripts/cortex-weekly-train.sh              # cut the train: preflight → gate → (on approval) promote
#   scripts/cortex-weekly-train.sh --preflight  # verify beta snapshot green; print candidate; no live change
#   scripts/cortex-weekly-train.sh --request    # preflight + raise the CTO approval request; halt (no live change)
#   scripts/cortex-weekly-train.sh --promote    # requires a valid approval token; run canary + fleet
#   scripts/cortex-weekly-train.sh --dry-run    # full walk-through, NO mutation, approval NOT consumed
#   scripts/cortex-weekly-train.sh --status     # print candidate / approval / pending state and exit
#
# Exit codes: 0 = train advanced (promoted, or halted cleanly awaiting approval, or dry/preflight
#             ok); 1 = aborted (beta not green, backup failed, promotion failed+rolled-back, or a
#             safety assert tripped — ALERT emitted).

set -euo pipefail

# --- Config (env-overridable) ------------------------------------------------------------
# Beta side (the snapshot source) — mirrors cortex-deploy.sh defaults so preflight reuses them.
CORTEX_BETA_TREE="${CORTEX_BETA_TREE:-/home/ubuntu/projects/cortex-beta}"
CORTEX_BETA_HEALTH_URL="${CORTEX_BETA_HEALTH_URL:-http://127.0.0.1:3200/api/health}"
CORTEX_BETA_BASE_URL="${CORTEX_BETA_BASE_URL:-${CORTEX_BETA_HEALTH_URL%/api/health}}"
CORTEX_BETA_CONFIG="${CORTEX_BETA_CONFIG:-/home/ubuntu/.paperclip/instances/beta/config.json}"

# Live orchestrator (the §5 promotion target) — cortex.neoreef.com, loopback :3100.
CORTEX_LIVE_TREE="${CORTEX_LIVE_TREE:-/home/ubuntu/projects/paperclip}"
CORTEX_LIVE_SERVICE="${CORTEX_LIVE_SERVICE:-paperclip.service}"
CORTEX_LIVE_HEALTH_URL="${CORTEX_LIVE_HEALTH_URL:-http://127.0.0.1:3100/api/health}"
CORTEX_LIVE_BASE_URL="${CORTEX_LIVE_BASE_URL:-${CORTEX_LIVE_HEALTH_URL%/api/health}}"
CORTEX_LIVE_CONFIG="${CORTEX_LIVE_CONFIG:-}"                 # optional; passed to db-type probes
CORTEX_LIVE_REMOTE="${CORTEX_LIVE_REMOTE:-origin}"
CORTEX_LIVE_STATE_FILE="${CORTEX_LIVE_STATE_FILE:-/var/tmp/cortex-weekly-train-live-last-good.ref}"
CORTEX_LIVE_HEALTH_RETRIES="${CORTEX_LIVE_HEALTH_RETRIES:-30}"
CORTEX_LIVE_HEALTH_INTERVAL="${CORTEX_LIVE_HEALTH_INTERVAL:-2}"

# Approval gate. The token file, when it holds THIS run's candidate SHA (first whitespace token
# on any non-comment line), authorizes promotion. Request hook is invoked as
# `$CMD "<candidate-sha>" "<summary>"` to raise the request_confirmation to Werner (CTO).
CORTEX_RELEASE_APPROVAL_FILE="${CORTEX_RELEASE_APPROVAL_FILE:-/var/tmp/cortex-release-approval.token}"
CORTEX_RELEASE_PENDING_FILE="${CORTEX_RELEASE_PENDING_FILE:-/var/tmp/cortex-release-pending.ref}"
CORTEX_RELEASE_APPROVAL_REQUEST_CMD="${CORTEX_RELEASE_APPROVAL_REQUEST_CMD:-}"

# Fleet ring. Stable npm `latest` cut + upgrade of any remaining instances. With a single live
# instance today the ring is empty (no-op) but the machinery is wired for future instances.
# CORTEX_FLEET_INSTANCES: whitespace/newline list of "name=/path/to/tree:service:healthurl"
# entries (empty today). CORTEX_FLEET_PUBLISH=1 arms the real `release.sh stable` npm publish;
# unset/0 runs it in --dry-run so a train never publishes npm without being explicitly armed.
CORTEX_FLEET_INSTANCES="${CORTEX_FLEET_INSTANCES:-}"
CORTEX_FLEET_PUBLISH="${CORTEX_FLEET_PUBLISH:-0}"

# Content-verify command builder — reuse 522b's verify-content.mjs against a given base URL.
CORTEX_TRAIN_LOCK="${CORTEX_TRAIN_LOCK:-/tmp/cortex-weekly-train.lock}"
# Optional alert sink, invoked as `$CMD "<message>"` on any abort/rollback (also always journald).
CORTEX_TRAIN_ALERT_CMD="${CORTEX_TRAIN_ALERT_CMD:-}"

# Out-of-band recovery handoff (522f / NEO-532). Before any live change the train materializes a
# pre-primed recovery artifact (changelog + LKG + restore/verify commands + tracing) to a stable
# host path, so a failed update can be recovered out-of-band even with the orchestrator down. If
# the deterministic auto-rollback below cannot restore green, the train escalates to the OOB
# recovery entrypoint (a host-level, independent-failure-domain agent — NOT a heartbeat here).
CORTEX_RELEASE_ROOT="${CORTEX_RELEASE_ROOT:-/var/lib/cortex-release}"
CORTEX_RELEASE_HANDOFF_SCRIPT="${CORTEX_RELEASE_HANDOFF_SCRIPT:-$CORTEX_BETA_TREE/scripts/cortex-release-handoff.sh}"
# Escalation hook fired ONLY when auto-rollback fails to restore green. Invoked as
# `$CMD <handoff-dir>`. Defaults to the OOB recovery entrypoint in --auto mode.
CORTEX_OOB_RECOVER_CMD="${CORTEX_OOB_RECOVER_CMD:-}"

MODE="train"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --) shift ;;
    --preflight) MODE="preflight"; shift ;;
    --request)   MODE="request";   shift ;;
    --promote)   MODE="promote";   shift ;;
    --dry-run)   MODE="dry-run";   shift ;;
    --status)    MODE="status";    shift ;;
    -h|--help) grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "cortex-weekly-train: unknown arg: $1" >&2; exit 2 ;;
  esac
done

log()   { printf '\033[1;35m[weekly-train]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[weekly-train] WARN:\033[0m %s\n' "$*" >&2; }
alert() {
  printf '\033[1;31m[weekly-train] ALERT:\033[0m %s\n' "$*" >&2
  if [[ -n "$CORTEX_TRAIN_ALERT_CMD" ]]; then
    "$CORTEX_TRAIN_ALERT_CMD" "cortex-weekly-train: $*" || warn "alert hook failed"
  fi
}
die()   { alert "$*"; exit 1; }

# --- Small helpers -----------------------------------------------------------------------
health_ok() {
  local url="$1" retries="${2:-$CORTEX_LIVE_HEALTH_RETRIES}" interval="${3:-$CORTEX_LIVE_HEALTH_INTERVAL}" i
  for ((i = 1; i <= retries; i++)); do
    curl -fsS --max-time 5 "$url" >/dev/null 2>&1 && return 0
    sleep "$interval"
  done
  return 1
}

# Run the 522b content-verify probe registry against a running instance. Skipped (return 0)
# when no probe files exist yet, so an empty registry never blocks a promotion.
verify_content_against() {
  local base="$1" config="$2"
  if ! { compgen -G "$CORTEX_BETA_TREE/release-probes/*.yaml" >/dev/null 2>&1 \
      || compgen -G "$CORTEX_BETA_TREE/release-probes/*.yml"  >/dev/null 2>&1 \
      || compgen -G "$CORTEX_BETA_TREE/release-probes/*.json" >/dev/null 2>&1; }; then
    log "no release-probes/* present — skipping content-verify against $base"
    return 0
  fi
  local env_prefix=""
  [[ -n "$config" ]] && env_prefix="PAPERCLIP_CONFIG='$config' "
  log "content-verify: $base"
  eval "${env_prefix}node '$CORTEX_BETA_TREE/scripts/verify-content.mjs' --base '$base' --dir '$CORTEX_BETA_TREE/release-probes'"
}

# The candidate = the exact commit beta has deployed + content-verified. Prefer the deploy
# agent's recorded last-known-good ref; fall back to beta tree HEAD.
resolve_candidate() {
  local state="${CORTEX_DEPLOY_STATE_FILE:-/var/tmp/cortex-deploy-last-good.ref}" ref=""
  if [[ -r "$state" ]]; then
    ref="$(tr -d '[:space:]' <"$state" 2>/dev/null || true)"
  fi
  if [[ -z "$ref" ]]; then
    ref="$(git -C "$CORTEX_BETA_TREE" rev-parse HEAD 2>/dev/null || true)"
  fi
  printf '%s' "$ref"
}

# First whitespace-delimited token on the first non-comment, non-blank line of the token file.
approval_token_sha() {
  [[ -r "$CORTEX_RELEASE_APPROVAL_FILE" ]] || return 0
  awk '!/^[[:space:]]*#/ && NF { print $1; exit }' "$CORTEX_RELEASE_APPROVAL_FILE" 2>/dev/null || true
}

approval_valid_for() {
  local candidate="$1" token
  token="$(approval_token_sha)"
  [[ -n "$token" && "$token" == "$candidate" ]]
}

request_approval() {
  local candidate="$1" summary="$2"
  printf '%s\n' "$candidate" >"$CORTEX_RELEASE_PENDING_FILE" 2>/dev/null \
    || warn "could not persist pending-promotion ref to $CORTEX_RELEASE_PENDING_FILE"
  log "requesting CTO release-approval for candidate ${candidate:0:12}"
  if [[ -n "$CORTEX_RELEASE_APPROVAL_REQUEST_CMD" ]]; then
    "$CORTEX_RELEASE_APPROVAL_REQUEST_CMD" "$candidate" "$summary" \
      || warn "approval-request hook failed — approval must be granted out of band"
  else
    warn "no CORTEX_RELEASE_APPROVAL_REQUEST_CMD set — raise the request_confirmation to Werner manually."
  fi
  log "TO APPROVE: write the candidate SHA to the token file, then re-run the train:"
  log "    echo '$candidate' > '$CORTEX_RELEASE_APPROVAL_FILE'"
  log "    scripts/cortex-weekly-train.sh --promote"
}

# --- Out-of-band recovery handoff (522f) --------------------------------------------------------
# The version change log for a cut — carried in the approval request so the CTO approves WITH the
# change summary (NEO-532 acceptance). Best-effort: never let changelog generation block the train.
release_changelog() {
  local candidate="$1"
  [[ -x "$CORTEX_RELEASE_HANDOFF_SCRIPT" ]] || { echo "(changelog unavailable — $CORTEX_RELEASE_HANDOFF_SCRIPT not executable)"; return 0; }
  CORTEX_RELEASE_ROOT="$CORTEX_RELEASE_ROOT" CORTEX_BETA_TREE="$CORTEX_BETA_TREE" \
  CORTEX_LIVE_TREE="$CORTEX_LIVE_TREE" CORTEX_LIVE_SERVICE="$CORTEX_LIVE_SERVICE" \
  CORTEX_LIVE_HEALTH_URL="$CORTEX_LIVE_HEALTH_URL" \
    "$CORTEX_RELEASE_HANDOFF_SCRIPT" changelog "$candidate" 2>/dev/null || echo "(changelog generation failed)"
}

# Materialize the pre-primed handoff artifact to the stable host path BEFORE any live change.
# Prints the handoff dir on success. Fatal on failure: without the handoff there is no OOB recovery
# path, so we refuse to promote (fail safe — nothing has changed live yet at this point).
materialize_handoff() {
  local candidate="$1" lkg="$2" dir
  [[ -x "$CORTEX_RELEASE_HANDOFF_SCRIPT" ]] || die "handoff script not executable ($CORTEX_RELEASE_HANDOFF_SCRIPT) — refusing to promote without an OOB recovery artifact."
  dir="$( CORTEX_RELEASE_ROOT="$CORTEX_RELEASE_ROOT" CORTEX_BETA_TREE="$CORTEX_BETA_TREE" \
          CORTEX_LIVE_TREE="$CORTEX_LIVE_TREE" CORTEX_LIVE_SERVICE="$CORTEX_LIVE_SERVICE" \
          CORTEX_LIVE_HEALTH_URL="$CORTEX_LIVE_HEALTH_URL" CORTEX_LIVE_BASE_URL="$CORTEX_LIVE_BASE_URL" \
          CORTEX_LIVE_CONFIG="$CORTEX_LIVE_CONFIG" CORTEX_LIVE_REMOTE="$CORTEX_LIVE_REMOTE" \
          "$CORTEX_RELEASE_HANDOFF_SCRIPT" materialize "$candidate" "$lkg" 2>/dev/null )" \
    || die "failed to materialize the OOB recovery handoff for ${candidate:0:12} — refusing to promote without a recovery artifact."
  printf '%s' "$dir"
}

# Append the concrete pre-promotion backup path to an already-materialized handoff (best-effort).
record_handoff_backup() {
  local candidate="$1" backup="$2"
  [[ -n "$backup" && -x "$CORTEX_RELEASE_HANDOFF_SCRIPT" ]] || return 0
  CORTEX_RELEASE_ROOT="$CORTEX_RELEASE_ROOT" "$CORTEX_RELEASE_HANDOFF_SCRIPT" \
    record-backup "${candidate:0:12}" "$backup" >/dev/null 2>&1 || warn "could not record backup into handoff"
}

# Escalate to the out-of-band recovery entrypoint — fired ONLY when the deterministic auto-rollback
# has failed to restore green. Runs host-level (this train is a systemd unit, not a heartbeat), so
# invoking it here keeps the independent-failure-domain contract. Best-effort: it is the last resort.
escalate_oob() {
  local handoff_dir="$1"
  local cmd="$CORTEX_OOB_RECOVER_CMD"
  [[ -n "$cmd" ]] || cmd="$CORTEX_BETA_TREE/scripts/cortex-oob-recover.sh --auto"
  alert "auto-rollback did NOT restore green — escalating to out-of-band recovery: $cmd --handoff ${handoff_dir:-$CORTEX_RELEASE_ROOT/latest}"
  # shellcheck disable=SC2086
  $cmd --handoff "${handoff_dir:-$CORTEX_RELEASE_ROOT/latest}" \
    || alert "OOB recovery entrypoint returned non-zero — live may still be DOWN; page the CTO and hold (do NOT re-attempt the forward promotion)."
}

# --- Live safety asserts: this is the ONLY sanctioned path that touches the live plane -----
assert_live_target() {
  [[ -d "$CORTEX_LIVE_TREE/.git" || -f "$CORTEX_LIVE_TREE/.git" ]] \
    || die "live tree is not a git working tree: $CORTEX_LIVE_TREE"
  case "$CORTEX_LIVE_HEALTH_URL" in
    http://127.0.0.1:*|http://localhost:*) : ;;
    *) die "live health URL is not loopback ($CORTEX_LIVE_HEALTH_URL) — refusing";;
  esac
  # The live service must be the orchestrator, never a beta unit (that path is 522a's, and it
  # must never be a build/migrate target here either).
  [[ "$CORTEX_LIVE_SERVICE" == *beta* ]] \
    && die "live service '$CORTEX_LIVE_SERVICE' looks like a beta unit — refusing (beta deploys via 522a, not the train)"
  [[ "$CORTEX_LIVE_TREE" == "$CORTEX_BETA_TREE" ]] \
    && die "live tree equals beta tree ($CORTEX_LIVE_TREE) — refusing (train must promote across instances, not in place)"
  return 0
}

build_tree() {
  local tree="$1"
  log "pnpm install ($tree)"
  ( cd "$tree"; unset NODE_ENV; pnpm install --frozen-lockfile )
  log "pnpm build ($tree)"
  ( cd "$tree"; unset NODE_ENV; pnpm build )
}

restart_service() { log "restart $1"; sudo systemctl restart "$1"; }

# --- Canary: promote the green beta snapshot onto the live orchestrator via §5 -------------
# Contract: db:backup FIRST, record last-known-good, promote candidate, build, migrate,
# doctor+health, content-verify. Any failure → roll code + DB back to the pre-promotion state.
canary_promote() {
  local candidate="$1" dry="$2"
  assert_live_target

  local lkg backup_ref=""
  lkg="$(git -C "$CORTEX_LIVE_TREE" rev-parse HEAD)"
  log "canary: promote ${candidate:0:12} → live (${CORTEX_LIVE_SERVICE}); current live ${lkg:0:12}"

  if [[ "$dry" == "1" ]]; then
    log "DRY-RUN canary: would (0) materialize OOB recovery handoff to $CORTEX_RELEASE_ROOT/<cut> BEFORE any live change,"
    log "DRY-RUN canary: (1) db:backup live, (2) record LKG ${lkg:0:12}, (3) checkout ${candidate:0:12},"
    log "DRY-RUN canary: (4) pnpm install+build, (5) db:generate+db:migrate, (6) doctor --repair + health, (7) content-verify; rollback→OOB-escalate on any fail."
    return 0
  fi

  # Guard: never build over in-progress work on the live tree.
  if [[ -n "$(git -C "$CORTEX_LIVE_TREE" status --porcelain --untracked-files=no)" ]]; then
    die "live tree has uncommitted tracked changes — refusing to promote over in-progress work."
  fi

  # Prove the candidate is actually reachable on the live plane BEFORE taking a backup — a
  # snapshot the live tree has never seen can never be promoted, so fail fast rather than leave
  # an orphaned pre-promotion backup behind. (Fetch is read-only; still no live mutation here.)
  log "§5.2 fetch $CORTEX_LIVE_REMOTE + verify candidate present"
  if ! git -C "$CORTEX_LIVE_TREE" fetch --quiet "$CORTEX_LIVE_REMOTE" 2>/dev/null; then
    warn "fetch of $CORTEX_LIVE_REMOTE failed — candidate must already be present locally"
  fi
  if ! git -C "$CORTEX_LIVE_TREE" cat-file -e "${candidate}^{commit}" 2>/dev/null; then
    die "candidate ${candidate:0:12} is not present in the live tree — cannot promote a snapshot the live plane has never seen."
  fi

  # 522f — materialize the pre-primed OOB recovery handoff to the stable host path BEFORE any live
  # change, so a failed update is recoverable out-of-band even with the orchestrator down. The
  # candidate is proven reachable above and no live state has changed yet; fatal if it can't be
  # written (no recovery artifact ⇒ no OOB path ⇒ refuse to promote).
  local handoff_dir
  handoff_dir="$(materialize_handoff "$candidate" "$lkg")"
  log "OOB recovery handoff pre-primed at $handoff_dir (readable with the orchestrator down)."

  # §5 step 1 — DB backup FIRST. No live mutation happens before this succeeds. The backup
  # path is recorded so a rollback can name the exact file to restore (restore is the manual
  # NEO-198 procedure — there is no db:restore CLI, so we surface it, never fake it).
  log "§5.1 db:backup (live) — required before any live change"
  local backup_json
  if ! backup_json="$( cd "$CORTEX_LIVE_TREE"; npx paperclipai db:backup --json 2>/dev/null )"; then
    die "live db:backup FAILED — aborting before any live change."
  fi
  backup_ref="$(printf '%s' "$backup_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.path||j.file||j.filename||j.backupPath||"")}catch{process.stdout.write("")}})' 2>/dev/null || true)"
  log "live backup taken: ${backup_ref:-<see db:backup output / configured backup dir>}"
  # Fill the concrete pre-promotion backup path into the handoff so an OOB restore names the exact
  # file to restore (this is still before the real promotion — code checkout below).
  record_handoff_backup "$candidate" "$backup_ref"

  printf '%s\n' "$lkg" >"$CORTEX_LIVE_STATE_FILE" 2>/dev/null || warn "could not persist live last-known-good ref"

  # Move the live tree to the exact validated snapshot SHA (never a moving branch ref).
  log "checkout ${candidate:0:12}"
  git -C "$CORTEX_LIVE_TREE" checkout --quiet --detach "$candidate"

  if ! promote_build_migrate_verify; then
    rollback_live "$lkg" "$backup_ref" "$handoff_dir"
    die "canary promotion of ${candidate:0:12} FAILED — rolled back live to ${lkg:0:12} + restored backup."
  fi

  log "canary: live is now serving ${candidate:0:12} and green."
  return 0
}

# The build/migrate/verify body shared by canary + fleet-ring upgrades. Returns non-zero on
# any failure so the caller can roll back.
promote_build_migrate_verify() {
  build_tree "$CORTEX_LIVE_TREE" || { warn "build failed"; return 1; }
  log "§5.2 db:generate && db:migrate (live)"
  ( cd "$CORTEX_LIVE_TREE"; unset NODE_ENV; pnpm db:generate && pnpm db:migrate ) || { warn "migrate failed"; return 1; }
  restart_service "$CORTEX_LIVE_SERVICE" || { warn "restart failed"; return 1; }
  log "§5.3 doctor --repair + health"
  ( cd "$CORTEX_LIVE_TREE"; npx paperclipai doctor --repair ) || warn "doctor --repair reported issues (continuing to health gate)"
  health_ok "$CORTEX_LIVE_HEALTH_URL" || { warn "live did not come healthy"; return 1; }
  verify_content_against "$CORTEX_LIVE_BASE_URL" "$CORTEX_LIVE_CONFIG" || { warn "content-verify failed"; return 1; }
  return 0
}

# §5 step 4 — rollback. Code side is automated (checkout LKG → rebuild → restart → health).
# The DB side is NOT auto-restored: there is no db:restore CLI, and rolling code back does not
# undo an already-applied migration (runbook §3). So if migrations may have applied, we emit a
# first-class ALERT naming the exact pre-promotion backup + the NEO-198 restore procedure rather
# than pretending a one-liner restore exists.
rollback_live() {
  local ref="$1" backup_ref="$2" handoff_dir="${3:-}"
  alert "rolling live CODE back to ${ref:0:12} (rebuild + restart)"
  git -C "$CORTEX_LIVE_TREE" checkout --quiet --force "$ref" 2>/dev/null || warn "code rollback checkout failed"
  build_tree "$CORTEX_LIVE_TREE" || warn "rebuild during rollback failed"
  restart_service "$CORTEX_LIVE_SERVICE" || warn "restart during rollback failed"
  if health_ok "$CORTEX_LIVE_HEALTH_URL"; then
    log "code rollback healthy — live restored to ${ref:0:12}"
  else
    # Deterministic auto-rollback itself failed — this is exactly the case 522f's out-of-band
    # recovery exists for: escalate to the host-level recovery entrypoint pointed at the
    # pre-primed handoff artifact (independent failure domain — the live plane is down).
    alert "code rollback did NOT come healthy — live may be DOWN; escalating to out-of-band recovery."
    escalate_oob "$handoff_dir"
  fi
  # DB: a failed promotion may have applied migrations that the code rollback cannot undo.
  alert "DB RESTORE MAY BE REQUIRED: if the failed promotion applied a migration, restore the pre-promotion backup \"${backup_ref:-<in the configured backup dir>}\" per DEV-PROCESS §5.4 / the NEO-198 runbook (stop service → restore backup → restart on ${ref:0:12}). Code-only rollback does not undo an applied migration."
}

# --- Fleet: stable npm cut + upgrade the remaining instance ring ---------------------------
fleet_stage() {
  local candidate="$1" dry="$2"

  # Stable `latest` cut. Publishing npm is a real external act — armed only by CORTEX_FLEET_PUBLISH=1;
  # otherwise release.sh runs in --dry-run so the train never publishes without being armed.
  local rel_args=("stable")
  if [[ "$dry" == "1" || "$CORTEX_FLEET_PUBLISH" != "1" ]]; then
    rel_args+=("--dry-run")
    log "fleet: stable cut (release.sh ${rel_args[*]}) — DRY (arm with CORTEX_FLEET_PUBLISH=1 to publish npm latest)"
  else
    log "fleet: stable cut (release.sh ${rel_args[*]}) — ARMED publish of npm latest"
  fi
  ( cd "$CORTEX_BETA_TREE"; ./scripts/release.sh "${rel_args[@]}" ) \
    || { [[ "$dry" == "1" ]] && warn "release.sh dry-run reported non-zero (non-fatal in dry mode)" || die "stable cut (release.sh stable) FAILED"; }

  # Upgrade the remaining instance ring. Empty today (single live instance) → documented no-op.
  if [[ -z "${CORTEX_FLEET_INSTANCES//[[:space:]]/}" ]]; then
    log "fleet: instance ring is empty (single live instance) — no-op ring, verify+rollback machinery wired for future instances."
    return 0
  fi
  local entry
  for entry in $CORTEX_FLEET_INSTANCES; do
    # entry = name=/tree:service:healthurl  — each ring member upgraded via §5, rollback on fail.
    log "fleet: would upgrade ring member '$entry' via §5 (build → migrate → verify → rollback on fail)"
    if [[ "$dry" == "1" ]]; then continue; fi
    warn "fleet: multi-instance upgrade requested but not exercised (no additional instances provisioned yet) — member '$entry' skipped; wire per-instance tree/service/health before arming."
  done
  return 0
}

# When sourced by tests (CORTEX_TRAIN_SOURCE_ONLY=1), stop here: expose the functions above as a
# library without running the train (lets the guardrails be unit-tested with no live instance).
[[ "${CORTEX_TRAIN_SOURCE_ONLY:-}" == "1" ]] && return 0 2>/dev/null || true

# --- Single-run lock ---------------------------------------------------------------------
exec 9>"$CORTEX_TRAIN_LOCK"
if ! flock -n 9; then
  log "another weekly-train run holds the lock; skipping."
  exit 0
fi

CANDIDATE="$(resolve_candidate)"
[[ -n "$CANDIDATE" ]] || die "could not resolve a beta candidate snapshot (no deploy state file, no beta HEAD)."

# --- status: report and exit --------------------------------------------------------------
if [[ "$MODE" == "status" ]]; then
  log "candidate (green beta snapshot): ${CANDIDATE}"
  tok="$(approval_token_sha)"
  log "approval token: ${tok:-<none>}  (valid for candidate: $(approval_valid_for "$CANDIDATE" && echo yes || echo no))"
  [[ -r "$CORTEX_RELEASE_PENDING_FILE" ]] && log "pending-promotion ref: $(cat "$CORTEX_RELEASE_PENDING_FILE")" || log "pending-promotion ref: <none>"
  log "live target: ${CORTEX_LIVE_SERVICE} @ ${CORTEX_LIVE_HEALTH_URL} (tree ${CORTEX_LIVE_TREE})"
  exit 0
fi

# --- Preflight: beta snapshot must be green (health + content-verify) ----------------------
log "preflight: candidate ${CANDIDATE:0:12} — checking beta is healthy + content-verified"
if ! health_ok "$CORTEX_BETA_HEALTH_URL" 5 2; then
  die "beta is not healthy ($CORTEX_BETA_HEALTH_URL) — refusing to cut a train from a red beta."
fi
if ! verify_content_against "$CORTEX_BETA_BASE_URL" "$CORTEX_BETA_CONFIG"; then
  die "beta content-verify FAILED — the snapshot is not green; refusing to promote."
fi
log "preflight OK: beta ${CANDIDATE:0:12} is healthy + content-verified."

if [[ "$MODE" == "preflight" ]]; then
  log "preflight-only: no live change made."
  exit 0
fi

# The approval request carries the version change log of the cut (522f / NEO-532 acceptance): the
# CTO approves WITH the change summary, and the same changelog is baked into the OOB handoff.
SUMMARY="Weekly release train: promote green beta snapshot ${CANDIDATE:0:12} to live (cortex.neoreef.com) via DEV-PROCESS §5.

$(release_changelog "$CANDIDATE")"

if [[ "$MODE" == "request" ]]; then
  request_approval "$CANDIDATE" "$SUMMARY"
  log "approval requested; halting (no live change). Re-run --promote once approved."
  exit 0
fi

if [[ "$MODE" == "dry-run" ]]; then
  log "DRY-RUN: approval gate is $(approval_valid_for "$CANDIDATE" && echo 'SATISFIED' || echo 'NOT satisfied') for ${CANDIDATE:0:12}"
  canary_promote "$CANDIDATE" 1
  fleet_stage "$CANDIDATE" 1
  log "DRY-RUN complete: no live change, no approval consumed."
  exit 0
fi

# --- Approval GATE: nothing below this line runs without a matching CTO approval token ------
if ! approval_valid_for "$CANDIDATE"; then
  log "no valid CTO approval token for candidate ${CANDIDATE:0:12} — HALTING before any live change."
  request_approval "$CANDIDATE" "$SUMMARY"
  log "train halted, awaiting CTO approval. The weekly timer (or --promote) resumes once approved."
  exit 0
fi
log "CTO approval token matches candidate ${CANDIDATE:0:12} — proceeding to canary + fleet."

# --- Promote: canary (§5 → live), then fleet (stable cut + ring) ---------------------------
canary_promote "$CANDIDATE" 0

# The token authorizes the LIVE promotion (canary), which is now done + verified green. Consume
# it immediately — before fleet — so a downstream fleet failure can't leave a still-valid token
# that a later tick would use to re-promote live without a fresh CTO approval. Live now serves
# the candidate, so record it as the new last-known-good.
log "canary green — consuming single-use approval token"
rm -f "$CORTEX_RELEASE_APPROVAL_FILE" "$CORTEX_RELEASE_PENDING_FILE" 2>/dev/null || true
printf '%s\n' "$CANDIDATE" >"$CORTEX_LIVE_STATE_FILE" 2>/dev/null || true

fleet_stage "$CANDIDATE" 0

log "weekly train complete: ${CANDIDATE:0:12} promoted to live + stable fleet cut. done."
