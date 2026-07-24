#!/usr/bin/env bash
#
# cutover-live.sh -- move the control plane off the development tree. (LOOA-382)
#
# Background: the server runs under `tsx watch` from the same checkout agents
# develop in, so a *save* is a deploy and a *checkout* is a deploy. LOOA-371
# made the bad **commit** impossible; it cannot make the bad **minute**
# impossible, because no git hook can see a save. The only way to remove that
# failure mode rather than police it is to serve from a tree no agent enters.
#
# Two things make this more than "restart a node process", and both are why this
# script exists instead of a wiki page:
#
#   1. The embedded Postgres postmaster is a CHILD of the server process, and
#      its binary is resolved from the serving tree's node_modules. Cutting over
#      restarts the company database, and does so from a different install.
#
#   2. Agent runs are children of the server too -- including the agent running
#      this script. Stopping the server decapitates its own operator. So this
#      script re-execs itself into a new session and finishes the job (including
#      rollback) with no live supervisor.
#
# Usage:
#   scripts/cutover-live.sh --dry-run              # preconditions only, no changes
#   scripts/cutover-live.sh                        # do it (detaches, logs, self-heals)
#   scripts/cutover-live.sh --serving-tree <path>
#
# On failure at any point after the server is stopped, it restores the previous
# tree and health-gates that too. The worst outcome it will accept is "we are
# back where we started"; it never exits leaving nothing serving.

set -uo pipefail

SERVING_TREE="${SERVING_TREE:-/Users/annica/paperclip-live}"
DRY_RUN=0
HEALTH_TIMEOUT_SECS=180
STOP_TIMEOUT_SECS=60
# How long to let the graceful `pnpm dev:stop` path free the port before we
# escalate to signalling the process that actually holds it. Short on purpose:
# dev:stop either stops the server quickly or no-ops (e.g. its registry record
# is stale/absent), and waiting the full stop timeout for a no-op just delays
# the swap for no gain.
GRACEFUL_STOP_SECS=25

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --serving-tree) SERVING_TREE="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${HOME}/.paperclip/instances/${PAPERCLIP_INSTANCE_ID:-default}/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/cutover-live.log"
RESULT_FILE="${LOG_DIR}/cutover-live.result.json"

log() { printf '[cutover %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { log "FAILED: $*"; }

# ---------------------------------------------------------------------------
# Detach. Stopping the server kills the agent that launched us (agent runs are
# its children), so a cutover supervised by that agent would be killed halfway
# through -- server down, nothing left running to bring it back. Re-exec into a
# new session so the cutover outlives its operator. macOS has no setsid(1);
# perl's POSIX::setsid is the portable way to get one.
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" -eq 0 ] && [ "${PAPERCLIP_CUTOVER_DETACHED:-0}" != "1" ]; then
  echo "cutover: detaching into its own session; following ${LOG_FILE}"
  echo "cutover: result will be written to ${RESULT_FILE}"
  PAPERCLIP_CUTOVER_DETACHED=1 \
    perl -e 'use POSIX qw(setsid); setsid(); exec @ARGV or die $!;' \
    -- bash "${BASH_SOURCE[0]}" --serving-tree "$SERVING_TREE" \
    >>"$LOG_FILE" 2>&1 &
  disown 2>/dev/null || true
  exit 0
fi

exec 2>&1

log "=============================================================="
log "cutover starting (dry-run=${DRY_RUN})"
log "serving tree candidate: ${SERVING_TREE}"

# ---------------------------------------------------------------------------
# Locate the tree that is serving right now, from the process, not a constant.
# ---------------------------------------------------------------------------
LIVE_JSON="$(node "${REPO_ROOT}/scripts/live-service.mjs" --json 2>/dev/null)"
OLD_TREE="$(printf '%s' "$LIVE_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.service?j.service.cwd:"")})')"
PORT="$(printf '%s' "$LIVE_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(String(j.service&&j.service.port?j.service.port:3100))})')"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"

# Start the new server with the same instance resolution the old one had. An
# inherited PAPERCLIP_HOME would silently point it at a different database --
# the one failure the health gate cannot see.
unset PAPERCLIP_HOME

# Identity fallback: ask the socket when the registry is silent.
#
# The registry is the honest answer WHILE the server maintains it -- but a failed
# `pnpm dev:stop` can delete the serving record while the server keeps running:
# dev:stop signals the dev-runner's registered pid, which may already have exited
# and orphaned the server, so the kill no-ops yet the record is removed anyway
# (this is precisely what the 2026-07-14 cutover left behind). After that,
# live-service.mjs reports nothing serving even though the port is held, and a
# cutover that trusted only the registry would refuse and strand us.
#
# So if the registry names no serving tree, ask the process actually listening
# on the health port who it is. Resolve its git top-level (its cwd may be a
# package subdir), which is the real serving tree -- read from the live socket,
# not a constant.
if [ -z "$OLD_TREE" ]; then
  OWNER_PID="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null | head -1)"
  if [ -n "$OWNER_PID" ]; then
    OWNER_CWD="$(lsof -a -p "$OWNER_PID" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    if [ -n "$OWNER_CWD" ]; then
      OLD_TREE="$(git -C "$OWNER_CWD" rev-parse --show-toplevel 2>/dev/null || true)"
      [ -n "$OLD_TREE" ] && \
        log "registry names no serving tree; resolved it from the pid holding port ${PORT} (pid ${OWNER_PID}): ${OLD_TREE}"
    fi
  fi
fi

if [ -z "$OLD_TREE" ]; then
  fail "no control plane is registered as serving; refusing to cut over a server that is already down"
  exit 1
fi
log "currently serving from: ${OLD_TREE} (port ${PORT})"

healthy() {
  curl -sf --max-time 5 "$HEALTH_URL" 2>/dev/null | grep -q '"status":"ok"'
}

wait_for_health() {
  local deadline=$(( SECONDS + HEALTH_TIMEOUT_SECS ))
  while [ $SECONDS -lt $deadline ]; do
    if healthy; then return 0; fi
    sleep 2
  done
  return 1
}

# Health is NOT proof the company is back.
#
# A server booted against an empty PAPERCLIP_HOME answers /api/health with
# exactly the same body as the live one -- 200, "status":"ok", and (verified,
# 2026-07-14) even "bootstrapStatus":"ready". Health tells you *a* server is up,
# never *whose data* it has.
#
# What does prove it: a server registers itself in the instance root it
# resolved. So a registration for our new tree appearing in the LIVE instance's
# registry is only possible if that server attached to the live instance. Find
# it there and the identity is settled; look for it and find nothing, and the
# server is up but serving somebody else's database.
serving_tree_per_registry() {
  node "${REPO_ROOT}/scripts/live-service.mjs" --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.service?j.service.cwd:"")}catch{process.stdout.write("")}})'
}

# ---------------------------------------------------------------------------
# Preconditions. Every one of these is a way the cutover is known to break;
# all are checked BEFORE anything is stopped, so a failure here costs nothing.
# ---------------------------------------------------------------------------
precondition_failures=0
check() {
  if eval "$2"; then
    log "  ok    -- $1"
  else
    log "  FAIL  -- $1"
    precondition_failures=$(( precondition_failures + 1 ))
  fi
}

log "preconditions:"
check "control plane is healthy right now" "healthy"
check "candidate serving tree exists" "[ -d '${SERVING_TREE}' ]"

# A LINKED WORKTREE MUST NOT BE THE SERVING TREE. The dev runner treats a linked
# worktree as an isolated dev instance: it demands .paperclip/.env and points
# PAPERCLIP_HOME at ~/.paperclip-worktrees. Serving from one would silently bring
# up an EMPTY company on port 3100. A plain clone has a real .git directory and
# resolves the default instance, which is the whole reason this is a clone.
check "serving tree is a real clone, not a linked worktree (.git is a directory)" \
  "[ -d '${SERVING_TREE}/.git' ]"
check "serving tree is on master" \
  "[ \"\$(git -C '${SERVING_TREE}' rev-parse --abbrev-ref HEAD)\" = 'master' ]"
check "serving tree is clean" \
  "[ -z \"\$(git -C '${SERVING_TREE}' status --porcelain)\" ]"
check "serving tree is at the same commit as the integration tree's master" \
  "[ \"\$(git -C '${SERVING_TREE}' rev-parse HEAD)\" = \"\$(git -C '${OLD_TREE}' rev-parse master)\" ]"
check "serving tree has node_modules installed" "[ -d '${SERVING_TREE}/node_modules' ]"

# Ask whether node_modules matches the code it is about to serve -- and ask it
# in a way that can actually answer NO.
#
# The obvious check, `cmp SERVING_TREE/pnpm-lock.yaml OLD_TREE/pnpm-lock.yaml`,
# looks like it tests that. It does not. We only ever cut over *after*
# fast-forwarding the serving tree to master, so by that point both trees are on
# the same commit and the two lockfiles are byte-identical BY CONSTRUCTION --
# whatever node_modules happens to contain. It passes on a tree installed a year
# ago just as happily as on a fresh one. A precondition that cannot fail at the
# moment it matters is not a precondition.
#
# pnpm *leaves a trace* of what it installed: node_modules/.pnpm/lock.yaml is a
# copy of the lockfile the current install was resolved from. Comparing the
# checked-out lockfile against that trace is a question with a real answer --
# it is the difference between a field the tree reports and a mark it left.
check "serving tree's node_modules was installed from the lockfile it will serve" \
  "cmp -s '${SERVING_TREE}/pnpm-lock.yaml' '${SERVING_TREE}/node_modules/.pnpm/lock.yaml'"

# The postmaster binary comes from the SERVING tree's node_modules and must be
# able to open a data directory initialised by the old one. A major-version skew
# here does not degrade -- Postgres refuses to start, and the company has no
# database.
PG_DATA_VERSION="$(cat "${HOME}/.paperclip/instances/${PAPERCLIP_INSTANCE_ID:-default}/db/PG_VERSION" 2>/dev/null || echo "?")"
check "serving tree ships embedded-postgres major ${PG_DATA_VERSION} (matches the cluster on disk)" \
  "ls -d '${SERVING_TREE}'/node_modules/.pnpm/@embedded-postgres+darwin-arm64@${PG_DATA_VERSION}.* >/dev/null 2>&1"

if [ "$precondition_failures" -gt 0 ]; then
  fail "${precondition_failures} precondition(s) failed -- nothing was stopped, the control plane is untouched"
  exit 1
fi
log "all preconditions passed"

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry run: stopping here. Nothing was changed."
  exit 0
fi

# ---------------------------------------------------------------------------
# Back up the database FIRST, while the server that owns it is still up.
# ---------------------------------------------------------------------------
log "backing up the database from the running server..."
if ( cd "$OLD_TREE" && pnpm db:backup >/dev/null 2>&1 ); then
  log "backup ok"
else
  fail "db:backup failed -- refusing to restart the database without a backup"
  exit 1
fi

start_server() {
  local tree="$1"
  log "starting server from ${tree}..."
  ( cd "$tree" && nohup pnpm dev >>"${LOG_DIR}/dev-server.log" 2>&1 & disown 2>/dev/null || true )
}

port_is_free() {
  ! lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1
}

# The pid that actually holds the port right now -- read from the socket, never
# assumed. The server relocates to the next port when its preferred one is busy,
# and the service registry can be stale or, after a failed dev:stop, empty. The
# socket is the one source that cannot lie about who is serving.
port_listener_pid() {
  lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null | head -1
}

# Wait for the port to be genuinely FREE, not merely unhealthy.
#
# Health going away is not the signal -- a server started while the old socket
# is still held quietly relocates to the next port, giving a "healthy" server no
# client is talking to. The socket being released is the signal.
wait_port_free() {
  local budget="${1:-$STOP_TIMEOUT_SECS}"
  local deadline=$(( SECONDS + budget ))
  while [ $SECONDS -lt $deadline ]; do
    if port_is_free; then
      # Give the postmaster a moment to checkpoint and release the data dir.
      sleep 3
      port_is_free && return 0
    fi
    sleep 2
  done
  return 1
}

# Send $1 to the listener's whole process GROUP when we can, so the `tsx watch`
# supervisor dies with the server child it would otherwise respawn. Fall back to
# the single pid when there is no usable group. Never signals our own group --
# the cutover runs detached in its own session (setsid), so refusing our own
# group can only ever guard a future caller that forgot to detach.
kill_target() { # $1=signal  $2=owner_pid  $3=pgid  $4=self_pgid
  if [ -n "$3" ] && [ "$3" -gt 1 ] 2>/dev/null && [ "$3" != "$4" ]; then
    kill -"$1" "-$3" 2>/dev/null || true
  else
    kill -"$1" "$2" 2>/dev/null || true
  fi
}

stop_server() {
  local tree="$1"
  log "stopping server in ${tree}..."

  # Graceful path: ask the dev supervisor to stop its own child and drop its
  # registry record. Enough whenever that supervisor is still alive.
  ( cd "$tree" && pnpm dev:stop >/dev/null 2>&1 )
  if wait_port_free "$GRACEFUL_STOP_SECS"; then
    return 0
  fi

  # dev:stop signals the pid in the service registry -- the dev-RUNNER's pid.
  # That runner can exit and orphan the `tsx watch` process that actually holds
  # the server; the kill then lands on a dead pid, no-ops, and the record is
  # removed anyway (this is exactly how the 2026-07-14 cutover aborted). So the
  # graceful path can leave the port held with nothing left in the registry to
  # aim at. Fall back to the pid the socket says is listening and take down its
  # whole process group, so the watcher cannot respawn the child we kill.
  local owner pgid self_pgid
  owner="$(port_listener_pid)"
  if [ -z "$owner" ]; then
    # Nobody is listening yet the port is not free -- let the caller time out.
    port_is_free && return 0
    return 1
  fi
  pgid="$(ps -o pgid= -p "$owner" 2>/dev/null | tr -d ' ')"
  self_pgid="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')"
  log "port ${PORT} still held by pid ${owner} (pgid ${pgid:-none}) after dev:stop; escalating"

  # SIGTERM first: the server traps it and stops embedded Postgres cleanly before
  # exiting, so the data dir is released in order for the new server to reopen.
  kill_target TERM "$owner" "$pgid" "$self_pgid"
  if wait_port_free; then
    log "old server stopped"
    return 0
  fi

  log "SIGTERM did not free port ${PORT} within ${STOP_TIMEOUT_SECS}s; escalating to SIGKILL"
  kill_target KILL "$owner" "$pgid" "$self_pgid"
  wait_port_free
}

rollback() {
  log "ROLLING BACK to ${OLD_TREE}"
  stop_server "$SERVING_TREE" || log "warning: the new server did not release ${PORT} cleanly"
  start_server "$OLD_TREE"
  if wait_for_health; then
    log "rollback succeeded -- serving from ${OLD_TREE} again"
    write_result "rolled_back" "$OLD_TREE" "$1"
    exit 1
  fi
  fail "ROLLBACK ALSO FAILED -- the control plane is DOWN and needs a human"
  log "recover with:  cd ${OLD_TREE} && pnpm dev"
  write_result "down" "" "$1"
  exit 2
}

write_result() {
  cat >"$RESULT_FILE" <<EOF
{
  "outcome": "$1",
  "servingTree": "$2",
  "detail": "$3",
  "previousTree": "${OLD_TREE}",
  "finishedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
  log "result written to ${RESULT_FILE}"
}

# ---------------------------------------------------------------------------
# The cutover. From here on, something is always being brought back up.
# ---------------------------------------------------------------------------
if ! stop_server "$OLD_TREE"; then
  fail "the old server did not stop within ${STOP_TIMEOUT_SECS}s -- it is still serving; aborting without changes"
  write_result "aborted" "$OLD_TREE" "old server would not stop"
  exit 1
fi
log "old server stopped"

start_server "$SERVING_TREE"

if ! wait_for_health; then
  fail "the new server did not become healthy within ${HEALTH_TIMEOUT_SECS}s"
  rollback "new server failed its health gate"
fi
log "port ${PORT} is healthy"

# Green health only means *a* server is up. This is the check that says it is
# OUR server, attached to the LIVE database.
NOW_SERVING="$(serving_tree_per_registry)"
if [ "$NOW_SERVING" != "$SERVING_TREE" ]; then
  fail "health is green but the live instance's registry says '${NOW_SERVING:-<nothing>}' is serving, not '${SERVING_TREE}'"
  fail "that means the new server came up against a different instance -- it is answering, but not with this company's data"
  rollback "served the wrong instance"
fi
log "registry confirms ${SERVING_TREE} is attached to the live instance"

log "CUTOVER COMPLETE -- the control plane now serves from ${SERVING_TREE}"
log "the development tree ${OLD_TREE} can no longer deploy anything by being edited"
log ""
log "deploys are now:  pnpm deploy:live"
write_result "cutover" "$SERVING_TREE" "healthy and registered"
exit 0
