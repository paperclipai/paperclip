#!/usr/bin/env bash
# Dedicated DEPLOY launcher for the pinned paperclip-deploy worktree.
# Never source launchd-start.sh. Logs live outside the replaceable worktree.
# Refuses to start when HEAD does not match the promotion receipt SHA.
set -euo pipefail

LOGIN_PATH="$(/bin/zsh -lic 'printf %s "$PATH"' 2>/dev/null || true)"
if [ -n "${LOGIN_PATH:-}" ]; then
  export PATH="$LOGIN_PATH"
else
  export PATH="/Users/glad0s/.grok/bin:/Users/glad0s/.local/bin:/Applications/Codex.app/Contents/Resources:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
fi

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

export PAPERCLIP_UI_DEV_MIDDLEWARE="${PAPERCLIP_UI_DEV_MIDDLEWARE:-true}"
# Generated 1080p review clips regularly exceed the legacy 10 MiB default.
# Keep a bounded process cap so the per-company attachment policy can enforce
# its 25 MiB TSM limit without silently rejecting the original render.
export PAPERCLIP_ATTACHMENT_MAX_BYTES="${PAPERCLIP_ATTACHMENT_MAX_BYTES:-26214400}"
# Never inherit control-plane DATABASE_URL into children (SEV-1 / 2026-06-29).
unset DATABASE_URL

DEPLOY_ROOT="${PAPERCLIP_DEPLOY_ROOT:-$HOME/paperclip-deploy}"
RECEIPT_PATH="${PAPERCLIP_DEPLOY_RECEIPT:-$HOME/.paperclip/deploy/current-receipt.json}"
LOG_DIR="${PAPERCLIP_DEPLOY_LOG_DIR:-$HOME/.paperclip/deploy/logs}"
LOCK_DIR="${PAPERCLIP_DEPLOY_LOCK_DIR:-$HOME/.paperclip/deploy/locks/pinned-deploy-start.lock}"

export PORT="${PORT:-3100}"
RUNTIME_PORT=$((PORT + 10000))

log() { echo "[pinned-deploy-start $(date '+%Y-%m-%dT%H:%M:%S%z')] $*" >&2; }

die() {
  log "FATAL: $*"
  exit 78
}

[ -d "$DEPLOY_ROOT" ] || die "deploy root missing: $DEPLOY_ROOT"
cd "$DEPLOY_ROOT"

if [ ! -f "$RECEIPT_PATH" ]; then
  die "promotion receipt missing: $RECEIPT_PATH (refuse boot without pinned SHA)"
fi

HEAD_SHA="$(git -C "$DEPLOY_ROOT" rev-parse HEAD 2>/dev/null || true)"
[ -n "$HEAD_SHA" ] || die "cannot resolve HEAD in $DEPLOY_ROOT"

RECEIPT_SHA="$(
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const sha = j.candidateSha || j.deploySha || "";
    if (!sha) process.exit(2);
    process.stdout.write(String(sha).trim());
  ' "$RECEIPT_PATH" 2>/dev/null || true
)"
[ -n "$RECEIPT_SHA" ] || die "receipt lacks candidateSha/deploySha: $RECEIPT_PATH"

# Accept full or abbreviated equality when receipt stores abbreviated SHA.
case "$HEAD_SHA" in
  "$RECEIPT_SHA"*) ;;
  *)
    case "$RECEIPT_SHA" in
      "$HEAD_SHA"*) ;;
      *) die "HEAD $HEAD_SHA does not match receipt SHA $RECEIPT_SHA" ;;
    esac
    ;;
esac

mkdir -p "$LOG_DIR" "$(dirname "$LOCK_DIR")"

if [ "${PAPERCLIP_STARTUP_GATE:-1}" = "1" ]; then
  RECEIPT_GATES_GREEN="$(
    node -e '
      const fs = require("fs");
      const receipt = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const gates = receipt.gates && typeof receipt.gates === "object" ? receipt.gates : {};
      const required = ["committed_sha", "worktree_env", "candidate_deps", "plist_lint", "uq_fixture", "source_gate", "server_typecheck"];
      const passed = (value) => value === "pass" || (value && typeof value === "object" && value.status === "pass");
      process.stdout.write(receipt.failedGateCount === 0 && required.every((key) => passed(gates[key])) ? "1" : "0");
    ' "$RECEIPT_PATH" 2>/dev/null || true
  )"
  if [ "$RECEIPT_GATES_GREEN" = "1" ] && git diff --quiet --ignore-submodules -- && git diff --cached --quiet --ignore-submodules --; then
    log "startup gate: reusing SHA-bound all-green promotion receipt"
  else
    log "startup gate: candidate source graph before supervisor handoff"
    if ! node "$DEPLOY_ROOT/server/scripts/dev-watch-gate.mjs"; then
      die "STARTUP_GATE_FAILURE: source graph/load smoke rejected; refusing boot"
    fi
  fi
fi

# Single-instance lock (macOS: atomic mkdir).
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  OLD_LOCK_PID="$(cat "$LOCK_DIR/pid" 2>/dev/null | tr -dc '0-9' || true)"
  if [ -n "$OLD_LOCK_PID" ] && kill -0 "$OLD_LOCK_PID" 2>/dev/null; then
    log "another deploy instance live (pid $OLD_LOCK_PID); backing off"
    exit 0
  fi
  log "reclaiming stale deploy lock (holder ${OLD_LOCK_PID:-none})"
  rm -rf "$LOCK_DIR" 2>/dev/null || true
  mkdir "$LOCK_DIR" 2>/dev/null || { log "could not acquire deploy lock"; exit 0; }
fi
echo "$$" >"$LOCK_DIR/pid"

# Deploy owns :PORT and :RUNTIME_PORT only. Never touch source :3101/:13101.
for RP in "$PORT" "$RUNTIME_PORT"; do
  OLD="$(lsof -tiTCP:"$RP" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$OLD" ]; then
    log "stopping previous listener on :$RP (pid $OLD)"
    kill -TERM $OLD 2>/dev/null || true
    for _ in $(seq 1 25); do
      lsof -tiTCP:"$RP" -sTCP:LISTEN >/dev/null 2>&1 || break
      sleep 1
    done
    STILL="$(lsof -tiTCP:"$RP" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$STILL" ]; then
      log "force-killing :$RP (pid $STILL)"
      kill -KILL $STILL 2>/dev/null || true
      sleep 1
    fi
  fi
done

log "HEAD=$HEAD_SHA receipt=$RECEIPT_SHA port=$PORT; starting pinned deploy server"
# The deploy tree is immutable between receipt promotions, so a development
# filesystem watcher adds no safety. Starting the server package directly
# avoids a full source snapshot on every production restart while preserving
# the startup typecheck/migration/issue-create gate above.
exec pnpm --filter @paperclipai/server dev
