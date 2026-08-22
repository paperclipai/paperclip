#!/usr/bin/env bash
# launchd entrypoint for the SOURCE Paperclip server. Unlike start-source.sh
# (manual use: backgrounds + returns), this stays in the FOREGROUND via `exec`
# so launchd owns the long-running server process and KeepAlive works. A script
# that backgrounds the server and exits would make launchd reap the whole group.
#
# 2026-06-14 restart-race hardening: the overnight process_lost storms were a
# relaunch colliding with the PREVIOUS instance's orphaned children. This script
# now takes a single-instance lock so two concurrent launchd spawns cannot race
# cleanup, and reclaims only source-server/runtime ports before handing off.
#
# 2026-06-17 DB-SPOF hardening: Postgres is supervised by
# scripts/paperclip-postgres-start.sh / ie.thinkstack.paperclip-postgres. This
# source launcher must never reap or parent the postmaster; server reloads should
# reconnect to DATABASE_URL instead of owning the DB lifecycle.
set -uo pipefail

# Adapters spawn CLIs (codex, claude, grok, hermes, agy, gemini) BY NAME, so the
# server needs the full login-shell PATH — codex lives in the Codex.app bundle and
# claude/grok/hermes/agy in ~/.local|.grok/bin, none of which are in a minimal PATH.
# Derive it from an interactive login shell so it tracks future installs; fall back
# to an explicit list of the known CLI dirs.
LOGIN_PATH="$(/bin/zsh -lic 'printf %s "$PATH"' 2>/dev/null)"
if [ -n "$LOGIN_PATH" ]; then
  export PATH="$LOGIN_PATH"
else
  export PATH="/Users/glad0s/.grok/bin:/Users/glad0s/.local/bin:/Applications/Codex.app/Contents/Resources:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
fi

# Pin the Node 22 runtime required by acpx 0.12 and the current workspace. The
# earlier Node 22/tsx 4.21 preflight race (TSMC-10172) is no longer applicable:
# the served lockfile now carries tsx 4.23. Keeping the pin here prevents
# launchd from silently falling back to the retired Node 20 runtime.
# Node pin (2026-08-22 upstream cutover): upstream now requires Node >=24.11.
# Prefer the nvm Node 24 install; fall back to the legacy ~/.local/bin node
# (hermes-bundled v22) only if 24 is missing. Decouples the control plane's
# Node from the hermes install so a hermes upgrade cannot change it.
NODE24_BIN="$(ls -d /Users/glad0s/.nvm/versions/node/v24.*/bin 2>/dev/null | sort -V | tail -1)"
NODE_LEGACY_BIN="/Users/glad0s/.local/bin"
if [ -n "$NODE24_BIN" ] && [ -x "$NODE24_BIN/node" ]; then
  export PATH="$NODE24_BIN:$PATH"
elif [ -x "$NODE_LEGACY_BIN/node" ]; then
  export PATH="$NODE_LEGACY_BIN:$PATH"
fi
export PAPERCLIP_UI_DEV_MIDDLEWARE=true
# 2026-07-11 DB-wipe hardening: DATABASE_URL deliberately NOT exported. The server
# reads it from ~/.paperclip/instances/default/config.json (database.connectionString),
# so no child process — tsx, esbuild, agent lanes — can ever inherit the control-plane
# URL from the environment. Never reintroduce an env export here (2026-06-29 SEV-1).
unset DATABASE_URL
ROOT="$HOME/paperclip"
cd "$ROOT"

# A marker left behind by a terminated process is the boot-time signal that the
# preceding server died before its launchd wrapper could complete a clean
# shutdown. The server's startup reconciliation runs before scheduler ticks;
# exporting this fact makes the unclean-restart cause explicit in its logs and
# gives the external launcher an auditable recovery boundary.
LIVENESS_MARKER="${PAPERCLIP_LIVENESS_MARKER:-$ROOT/.devlogs/paperclip-source.liveness}"
mkdir -p "$(dirname "$LIVENESS_MARKER")"
if [ -e "$LIVENESS_MARKER" ]; then
  export PAPERCLIP_UNCLEAN_SHUTDOWN=1
  log() { echo "[launchd-start $(date '+%H:%M:%S')] $*" >&2; }
  log "UNCLEAN_SHUTDOWN_DETECTED: previous liveness marker remains at $LIVENESS_MARKER"
  rm -f "$LIVENESS_MARKER"
else
  export PAPERCLIP_UNCLEAN_SHUTDOWN=0
fi

# --- Coexist mode (TSMC-10172 follow-up). The LIVE fleet (:3100 + runtime :13100)
# is served from a pinned DEPLOY worktree; THIS launchd job runs the source/dev
# server ALONGSIDE it on a dedicated port. Pinning PORT keeps the source server off
# :3100 so a source-server crash or restart can NEVER evict the live deploy fleet.
# The runtime identity port follows as PORT+10000 (3101 -> 13101). Opt back into the
# legacy "source server reclaims :3100" behaviour with PAPERCLIP_RECLAIM_PRIMARY=1.
export PORT="${PORT:-3101}"
RUNTIME_PORT=$(( PORT + 10000 ))
RECLAIM_PRIMARY="${PAPERCLIP_RECLAIM_PRIMARY:-0}"

log() { echo "[launchd-start $(date '+%H:%M:%S')] $*" >&2; }

# Boot-time gate: dev-watch protects a running process from bad edits, but it
# cannot protect the first import after launchd starts. Prove the full source
# graph can load before handing it to the supervisor. The external watchdog
# recognises the explicit failure marker and only reverts to a SHA that served.
if [ "${PAPERCLIP_STARTUP_GATE:-1}" = "1" ]; then
  log "startup gate: checking source graph before supervisor handoff"
  if ! node "$ROOT/server/scripts/dev-watch-gate.mjs"; then
    log "STARTUP_GATE_FAILURE: source graph/load smoke rejected; refusing boot"
    "$ROOT/scripts/paperclip-crash-loop-alert.sh" || true
    exit 78
  fi
fi

# --- Single-instance guard (macOS has no flock): atomic mkdir lock + stale detection.
# After `exec pnpm dev` the shell is REPLACED in place, so the lock pid ($$) keeps
# pointing at the live server for its whole lifetime. A second launchd spawn that
# races in sees the lock held by a live pid and backs off (exit 0 -> KeepAlive
# retries later). When the server dies the pid goes dead and the next start
# reclaims the stale lock. We deliberately do NOT trap-remove the lock on exit.
LOCK_DIR="$ROOT/.devlogs/launchd-start.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  OLD_LOCK_PID="$(cat "$LOCK_DIR/pid" 2>/dev/null | tr -dc '0-9')"
  if [ -n "$OLD_LOCK_PID" ] && kill -0 "$OLD_LOCK_PID" 2>/dev/null; then
    log "another start/instance is live (pid $OLD_LOCK_PID); backing off"
    exit 0
  fi
  log "reclaiming stale lock (holder ${OLD_LOCK_PID:-none} is dead)"
  rm -rf "$LOCK_DIR" 2>/dev/null || true
  mkdir "$LOCK_DIR" 2>/dev/null || { log "could not acquire lock; backing off"; exit 0; }
fi
echo "$$" > "$LOCK_DIR/pid"

# --- Stop a previous instance of THIS source server and WAIT for drain. In coexist
# mode we only reclaim our OWN port (:$PORT); the live deploy fleet on :3100 is left
# untouched. Legacy reclaim-primary mode (opt-in) also evicts :3100 + `paperclipai run`.
if [ "$RECLAIM_PRIMARY" = "1" ]; then
  pkill -f "paperclipai run" 2>/dev/null || true
  RECLAIM_PORTS="3100 $PORT"
else
  RECLAIM_PORTS="$PORT"
fi
for RP in $RECLAIM_PORTS; do
  OLD=$(lsof -tiTCP:$RP -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$OLD" ]; then
    log "stopping previous server on :$RP (pid $OLD)"
    kill -TERM $OLD 2>/dev/null || true
    for _ in $(seq 1 25); do lsof -tiTCP:$RP -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 1; done
    STILL=$(lsof -tiTCP:$RP -sTCP:LISTEN 2>/dev/null || true)
    [ -n "$STILL" ] && { log "force-killing :$RP (pid $STILL)"; kill -KILL $STILL 2>/dev/null || true; sleep 1; }
  fi
done

# --- Free orphaned runtime identity port(s) left by detached dev-servers. Coexist
# mode only frees OUR runtime port ($RUNTIME_PORT); the deploy fleet's :13100 is left
# alone (reclaim-primary mode also frees :13100).
if [ "$RECLAIM_PRIMARY" = "1" ]; then
  RUNTIME_PORTS="13100 $RUNTIME_PORT"
else
  RUNTIME_PORTS="$RUNTIME_PORT"
fi
for P in $RUNTIME_PORTS; do
  OWN=$(lsof -tiTCP:$P -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$OWN" ]; then
    log "freeing runtime port $P (pid $OWN)"
    kill -TERM $OWN 2>/dev/null || true
    sleep 2
    kill -KILL $(lsof -tiTCP:$P -sTCP:LISTEN 2>/dev/null) 2>/dev/null || true
  fi
done

# --- @paperclipai dependency-symlink integrity guard (2026-06-17; see memory
# paperclip-worktree-symlink-hazard). A `pnpm install` run from a paperclip-wt-*
# worktree whose node_modules symlink into THIS repo clobbers
# server/node_modules/@paperclipai/* — repointing them at the worktree's UNBUILT
# packages, so the server crash-loops on ERR_MODULE_NOT_FOUND (e.g.
# plugin-sdk/dist/index.js) and never self-recovers. Self-heal: repoint any link
# whose target is outside $ROOT back to the matching $ROOT/packages/... path.
PC_DEPS="$ROOT/server/node_modules/@paperclipai"
if [ -d "$PC_DEPS" ]; then
  for dep in "$PC_DEPS"/*; do
    [ -L "$dep" ] || continue
    tgt="$(readlink "$dep" 2>/dev/null)" || continue
    case "$tgt" in
      "$ROOT"/*) : ;;                       # already resolves into the main repo — ok
      */packages/*)                         # hijacked to another repo/worktree
        main_tgt="$ROOT/packages/${tgt#*/packages/}"
        if [ -d "$main_tgt" ]; then
          ln -sfn "$main_tgt" "$dep"
          log "integrity-guard: repointed hijacked dep $(basename "$dep") -> $main_tgt"
        else
          log "integrity-guard: WARNING hijacked dep $(basename "$dep") -> $tgt but main target missing"
        fi
        ;;
    esac
  done
fi

printf 'pid=%s startedAt=%s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LIVENESS_MARKER"
clean_shutdown=0
child_pid=""

shutdown_cleanly() {
  clean_shutdown=1
  if [ -n "$child_pid" ] && kill -0 "$child_pid" 2>/dev/null; then
    kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  rm -f "$LIVENESS_MARKER"
  exit 0
}
trap shutdown_cleanly INT TERM

log "cleanup complete; starting source server (liveness marker $LIVENESS_MARKER)"
# Keep this wrapper in the foreground so launchd continues to supervise it.
# On INT/TERM the trap removes the marker only after relaying shutdown to the
# dev runner; an unexpected exit deliberately leaves the marker for next boot.
pnpm dev &
child_pid=$!
set +e
wait "$child_pid"
exit_status=$?
set -e
if [ "$clean_shutdown" != "1" ]; then
  log "UNEXPECTED_SERVER_EXIT: code $exit_status; preserving liveness marker"
  "$ROOT/scripts/paperclip-crash-loop-alert.sh" || true
fi
exit "$exit_status"
