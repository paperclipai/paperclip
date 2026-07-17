#!/usr/bin/env bash
# cortex-deploy.sh — on-host, pull-based deploy agent for the cortex-beta instance.
#
# NEO-526 (subtask 522a of NEO-522, the Cortex CI/CD weekly-release pipeline). This is the
# ROOT of the pipeline chain: it carries merged `origin/master` onto the *running* cortex-beta
# instance with no manual step.
#
#   fetch → ff-only → pnpm build → restart service → health gate → (auto-rollback on failure)
#
# It is meant to be driven by cortex-deploy.timer/.service (systemd oneshot), so every run is
# journalctl-observable:
#
#   journalctl -u cortex-deploy -f
#
# --- Guardrails (Hard Rules) -------------------------------------------------------------
# * beta is the SINGLE sanctioned exception to DEV-PROCESS §5 (in-place build of a shared
#   tree). This script only ever touches the beta tree + paperclip-beta.service. It refuses
#   to run against anything that is not a loopback beta target (see the safety asserts below),
#   so it can never build/migrate/restart the live orchestrator (:3100) or the canonical
#   source tree.
# * All DB ops go through the runtime, never raw psql (Hard Rule #1). Migrations apply ONLY
#   via the service's boot auto-apply (PAPERCLIP_MIGRATION_AUTO_APPLY=true). This script never
#   invokes `pnpm db:migrate` or psql.
# * Deploy happens only inside the agent's controlled window (the systemd timer interval).
#
# Usage:
#   scripts/cortex-deploy.sh                # one deploy cycle (fetch → ff → build → restart)
#   scripts/cortex-deploy.sh --check        # pre-flight only: report target vs deployed, no mutation
#   scripts/cortex-deploy.sh --dry-run      # fetch + report what WOULD deploy, no build/restart
#
# Exit codes: 0 = deployed (or already up to date / nothing to do); 1 = aborted (alert emitted).

set -euo pipefail

# --- Config (env-overridable; defaults target the real beta host) ------------------------
CORTEX_BETA_TREE="${CORTEX_BETA_TREE:-/home/ubuntu/projects/cortex-beta}"
CORTEX_BETA_REMOTE="${CORTEX_BETA_REMOTE:-origin}"
CORTEX_BETA_BRANCH="${CORTEX_BETA_BRANCH:-master}"          # deploy target = <remote>/<branch>
CORTEX_BETA_SERVICE="${CORTEX_BETA_SERVICE:-paperclip-beta.service}"
CORTEX_BETA_HEALTH_URL="${CORTEX_BETA_HEALTH_URL:-http://127.0.0.1:3200/api/health}"
CORTEX_DEPLOY_HEALTH_RETRIES="${CORTEX_DEPLOY_HEALTH_RETRIES:-30}"
CORTEX_DEPLOY_HEALTH_INTERVAL="${CORTEX_DEPLOY_HEALTH_INTERVAL:-2}"
CORTEX_DEPLOY_LOCK="${CORTEX_DEPLOY_LOCK:-/tmp/cortex-deploy.lock}"
CORTEX_DEPLOY_STATE_FILE="${CORTEX_DEPLOY_STATE_FILE:-/var/tmp/cortex-deploy-last-good.ref}"
# Content-verify gate (NEO-527 / subtask 522b). Invoked after the health gate passes; a non-zero
# exit triggers the same auto-rollback as an unhealthy restart. When left unset, the gate defaults
# (once beta is healthy) to running the whole release-probes/ registry against the running instance
# via scripts/verify-content.mjs — asserting behaviour/content, never SHA ancestry. It is skipped
# only when no probe files exist yet, so an empty registry never rolls back a healthy deploy.
CORTEX_DEPLOY_VERIFY_CMD="${CORTEX_DEPLOY_VERIFY_CMD:-}"
# Base URL of the running instance for content probes (health URL minus the /api/health suffix).
CORTEX_BETA_BASE_URL="${CORTEX_BETA_BASE_URL:-${CORTEX_BETA_HEALTH_URL%/api/health}}"
# Instance config the beta service uses — passed to db-type probes so they assert the live DB.
CORTEX_BETA_CONFIG="${CORTEX_BETA_CONFIG:-/home/ubuntu/.paperclip/instances/beta/config.json}"
# Optional alert sink. Invoked as `$CORTEX_DEPLOY_ALERT_CMD "<message>"` on any abort/rollback.
# When unset, alerts still land in stderr/journald (grep for the ALERT marker).
CORTEX_DEPLOY_ALERT_CMD="${CORTEX_DEPLOY_ALERT_CMD:-}"

MODE="deploy"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --) shift ;;
    --check)   MODE="check";   shift ;;
    --dry-run) MODE="dry-run"; shift ;;
    -h|--help) grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "cortex-deploy: unknown arg: $1" >&2; exit 2 ;;
  esac
done

TARGET_REF="${CORTEX_BETA_REMOTE}/${CORTEX_BETA_BRANCH}"

log()   { printf '\033[1;36m[cortex-deploy]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[cortex-deploy] WARN:\033[0m %s\n' "$*" >&2; }
alert() {
  # First-class alert: always visible in journald, plus the optional external sink.
  printf '\033[1;31m[cortex-deploy] ALERT:\033[0m %s\n' "$*" >&2
  if [[ -n "$CORTEX_DEPLOY_ALERT_CMD" ]]; then
    "$CORTEX_DEPLOY_ALERT_CMD" "cortex-deploy: $*" || warn "alert hook failed"
  fi
}
die()   { alert "$*"; exit 1; }

health_ok() {
  local i
  for ((i = 1; i <= CORTEX_DEPLOY_HEALTH_RETRIES; i++)); do
    if curl -fsS --max-time 5 "$CORTEX_BETA_HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$CORTEX_DEPLOY_HEALTH_INTERVAL"
  done
  return 1
}

# Build with dev dependencies present. The beta *service* runs NODE_ENV=production, but the
# build needs devDeps (tsc/vite), so we must NOT inherit production here.
build_tree() {
  log "pnpm install"
  ( unset NODE_ENV; pnpm install --frozen-lockfile )
  log "pnpm build (produces ui/dist)"
  ( unset NODE_ENV; pnpm build )
}

restart_service() {
  log "restarting ${CORTEX_BETA_SERVICE} (migrations auto-apply on boot)"
  sudo systemctl restart "$CORTEX_BETA_SERVICE"
}

# Roll the tree back to a known-good ref, rebuild, restart, and re-check health. Used when a
# fresh deploy fails to come healthy (or fails the content-verify gate).
rollback_to() {
  local ref="$1"
  alert "rolling back to last-known-good ${ref:0:12}"
  git reset --hard "$ref"
  build_tree
  restart_service
  if health_ok; then
    log "rollback healthy — last-known-good ${ref:0:12} restored"
  else
    alert "rollback did NOT come healthy — beta may be DOWN; manual intervention required"
  fi
}

# --- Single-run lock: a slow build must never overlap the next timer tick -----------------
exec 9>"$CORTEX_DEPLOY_LOCK"
if ! flock -n 9; then
  log "another cortex-deploy run holds the lock; skipping this tick"
  exit 0
fi

# --- Safety asserts: refuse anything that is not a loopback beta target -------------------
[[ -d "$CORTEX_BETA_TREE/.git" || -f "$CORTEX_BETA_TREE/.git" ]] \
  || die "target tree is not a git working tree: $CORTEX_BETA_TREE"
case "$CORTEX_BETA_HEALTH_URL" in
  http://127.0.0.1:*|http://localhost:*) : ;;
  *) die "health URL is not loopback ($CORTEX_BETA_HEALTH_URL) — refusing (never deploy a non-loopback/live target)";;
esac
[[ "$CORTEX_BETA_SERVICE" == *beta* ]] \
  || die "service '$CORTEX_BETA_SERVICE' is not a beta unit — refusing (never restart the live orchestrator)"

cd "$CORTEX_BETA_TREE"

log "tree:    $CORTEX_BETA_TREE"
log "target:  $TARGET_REF"
log "service: $CORTEX_BETA_SERVICE"

log "fetching $CORTEX_BETA_REMOTE"
git fetch --quiet "$CORTEX_BETA_REMOTE" "$CORTEX_BETA_BRANCH"

LKG="$(git rev-parse HEAD)"                 # last-known-good = the commit currently deployed
TARGET="$(git rev-parse "$TARGET_REF")"
log "deployed: ${LKG:0:12}"
log "merged:   ${TARGET:0:12}"

if [[ "$LKG" == "$TARGET" ]]; then
  log "already at ${TARGET:0:12} — nothing to deploy."
  exit 0
fi

# ff-only gate: the deployed commit must be an ancestor of the target, or this is not a
# fast-forward and we refuse (keeps the last-known-good running, emits an alert).
if ! git merge-base --is-ancestor "$LKG" "$TARGET"; then
  die "deployed ${LKG:0:12} is NOT an ancestor of ${TARGET_REF} ${TARGET:0:12} — non-ff, refusing (no half-deploy). Reconcile the beta tree with ${CORTEX_BETA_BRANCH} manually."
fi

# A dirty tree means someone is mid-work in the shared tree — never build over it.
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  git status --short | sed 's/^/    /' >&2
  die "beta tree has uncommitted tracked changes — refusing to deploy over in-progress work."
fi

if [[ "$MODE" == "check" || "$MODE" == "dry-run" ]]; then
  log "$MODE: would fast-forward ${LKG:0:12} → ${TARGET:0:12} ($(git rev-list --count "$LKG".."$TARGET") commit(s)), then build + restart + health-gate."
  git --no-pager log --oneline "$LKG".."$TARGET" | sed 's/^/    /'
  log "$MODE: no changes made."
  exit 0
fi

# --- Deploy ------------------------------------------------------------------------------
log "recording last-known-good ${LKG:0:12} → $CORTEX_DEPLOY_STATE_FILE"
printf '%s\n' "$LKG" >"$CORTEX_DEPLOY_STATE_FILE" 2>/dev/null || warn "could not persist last-known-good ref"

log "fast-forward ${LKG:0:12} → ${TARGET:0:12}"
git merge --ff-only "$TARGET"

# Build BEFORE restart. If the build fails, the old process is still running the old source,
# so restore the tree to match it and abort — the last-known-good stays live.
if ! build_tree; then
  warn "build failed — restoring tree to last-known-good ${LKG:0:12} (running instance untouched)"
  git reset --hard "$LKG"
  die "build failed for ${TARGET:0:12} — kept last-known-good ${LKG:0:12} running."
fi

restart_service

if ! health_ok; then
  warn "beta did not come healthy after restart; last 30 journald lines:"
  journalctl -u "$CORTEX_BETA_SERVICE" -n 30 --no-pager 2>/dev/null | sed 's/^/    /' >&2 || true
  rollback_to "$LKG"
  die "deploy of ${TARGET:0:12} was UNHEALTHY — rolled back to ${LKG:0:12}."
fi

# Content-verify gate (522b hook). Runs only once beta is healthy.
if [[ -z "$CORTEX_DEPLOY_VERIFY_CMD" ]]; then
  # Default gate: run the whole release-probes registry against the running instance. Skipped
  # when no probe files exist yet — never roll back a healthy deploy over an empty registry.
  if compgen -G "release-probes/*.yaml" >/dev/null 2>&1 \
    || compgen -G "release-probes/*.yml" >/dev/null 2>&1 \
    || compgen -G "release-probes/*.json" >/dev/null 2>&1; then
    CORTEX_DEPLOY_VERIFY_CMD="PAPERCLIP_CONFIG='$CORTEX_BETA_CONFIG' node scripts/verify-content.mjs --base '$CORTEX_BETA_BASE_URL' --dir release-probes"
  else
    log "no release-probes/*.yaml present — skipping content-verify gate"
  fi
fi
if [[ -n "$CORTEX_DEPLOY_VERIFY_CMD" ]]; then
  log "running content-verify gate: $CORTEX_DEPLOY_VERIFY_CMD"
  if ! eval "$CORTEX_DEPLOY_VERIFY_CMD"; then
    rollback_to "$LKG"
    die "content-verify gate FAILED for ${TARGET:0:12} — rolled back to ${LKG:0:12}."
  fi
fi

printf '%s\n' "$TARGET" >"$CORTEX_DEPLOY_STATE_FILE" 2>/dev/null || true
log "beta healthy:"
curl -fsS "$CORTEX_BETA_HEALTH_URL" && echo
log "deployed ${TARGET:0:12} to beta. done."
