#!/usr/bin/env bash
# cortex-beta refresh / rollback helper (NEO-257).
#
# Implements decision D1 of the NEO-217 plan: a *manual*, controlled-window refresh of the
# cortex-beta instance — build -> migrate beta DB -> restart. The migrate step is performed
# by the runtime at boot: the systemd unit sets PAPERCLIP_MIGRATION_AUTO_APPLY=true +
# PAPERCLIP_MIGRATION_PROMPT=never, so `applyPendingMigrations` (server/src/index.ts) runs
# every restart. There is no separate `pnpm db:migrate` step.
#
# IMPORTANT — beta uniquely runs from the *shared canonical agent source* tree, not a
# worktree (NEO-250/253). A refresh therefore BUILDS THE SHARED TREE IN PLACE. Run it only
# in a controlled window when no other agent is mid-build against this tree. This is the one
# sanctioned exception to DEV-PROCESS Hard Rule #5; it is gated behind --yes / BETA_REFRESH_CONFIRM=1.
#
# This file lives on the cortex-beta branch ONLY (D8 hygiene): it references the private
# beta instance layout and must never be merged to public `master`.
#
# Usage:
#   scripts/beta-refresh.sh --check                 # pre-flight only; no build/restart
#   scripts/beta-refresh.sh --yes                   # refresh current cortex-beta HEAD
#   scripts/beta-refresh.sh --rollback <git-ref> --yes   # roll beta back to a known-good ref
#
# Env:
#   BETA_REFRESH_CONFIRM=1   equivalent to passing --yes
set -euo pipefail

REPO="/home/ubuntu/.paperclip/instances/default/projects/0078c9af-0cf5-4887-8269-a3d36bd9680b/8764704b-ec53-44e0-b010-7d94b0cdb60f/paperclip"
SERVICE="paperclip-beta.service"
HEALTH_URL="http://127.0.0.1:3200/api/health"
BETA_LOG="/home/ubuntu/.paperclip/instances/beta/logs/server.log"
EXPECTED_BRANCH="cortex-beta"

MODE="refresh"
ROLLBACK_REF=""
CONFIRM="${BETA_REFRESH_CONFIRM:-0}"
CHECK_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --) shift ;;                          # tolerate pnpm's `-- ` arg separator
    --check) CHECK_ONLY=1; shift ;;
    --yes|-y) CONFIRM=1; shift ;;
    --rollback) MODE="rollback"; ROLLBACK_REF="${2:-}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[1;36m[beta-refresh]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[beta-refresh] WARN:\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[beta-refresh] FATAL:\033[0m %s\n' "$*" >&2; exit 1; }

cd "$REPO"

# --- Pre-flight ------------------------------------------------------------
branch="$(git rev-parse --abbrev-ref HEAD)"
log "repo:   $REPO"
log "branch: $branch (expected: $EXPECTED_BRANCH)"
[[ "$branch" == "$EXPECTED_BRANCH" ]] || die "not on $EXPECTED_BRANCH — beta serves from this branch; refusing."

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  warn "working tree has tracked, uncommitted changes:"
  git status --short | sed 's/^/    /'
  [[ "$MODE" == "rollback" ]] && die "rollback checkout is non-forcing; commit/stash tracked changes first."
  warn "they will be compiled into the beta build as-is."
fi

log "submodule pins:"
git submodule status | sed 's/^/    /'

if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
  log "current beta health: OK ($HEALTH_URL)"
else
  warn "current beta health check failed (it may already be down)."
fi

if [[ "$CHECK_ONLY" == "1" ]]; then
  log "--check only: no build/restart performed."
  exit 0
fi

[[ "$CONFIRM" == "1" ]] || die "refusing to build the shared tree without --yes (or BETA_REFRESH_CONFIRM=1). Use a controlled window."

# --- Rollback: move HEAD to the known-good ref first -----------------------
if [[ "$MODE" == "rollback" ]]; then
  [[ -n "$ROLLBACK_REF" ]] || die "--rollback requires a git ref."
  prev="$(git rev-parse HEAD)"
  log "rollback: $prev -> $ROLLBACK_REF"
  git checkout "$ROLLBACK_REF"          # non-forcing; aborts on conflict
  git submodule update --init --recursive
fi

# --- Build (needs devDeps: do NOT set NODE_ENV=production here) -------------
log "syncing submodules to pinned commits"
git submodule update --init --recursive
log "pnpm install"
pnpm install
log "pnpm build"
pnpm build

# --- Restart (runtime auto-applies pending migrations at boot) -------------
log "restarting $SERVICE (migrations auto-apply on boot)"
sudo systemctl restart "$SERVICE"

# --- Health gate -----------------------------------------------------------
log "waiting for beta to come healthy"
ok=0
for i in $(seq 1 30); do
  if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
if [[ "$ok" != "1" ]]; then
  warn "beta did NOT come healthy. Last 30 log lines:"
  tail -n 30 "$BETA_LOG" 2>/dev/null | sed 's/^/    /'
  die "refresh FAILED — roll back with: scripts/beta-refresh.sh --rollback <last-good-ref> --yes"
fi
log "beta healthy:"
curl -fsS "$HEALTH_URL"; echo
log "done. (refresh of $(git rev-parse --short HEAD) on $branch)"
