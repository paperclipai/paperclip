#!/usr/bin/env bash
# Launcher for the paperclip-btcaaaaa-main dev server.
#
# Use this instead of inlining the tmux command. The inline form that's
# been passed around to agents historically hard-codes
# `PAPERCLIP_DEV_SERVER_STATUS_FILE=/dev/null/paperclip-dev-status` after
# the `.env` source, which silently overrides the correct value from `.env`
# and breaks the dev-runner's auto-restart: it consumes the
# restart-request file but writes its `lastRestartAt` to a path the
# server can't see, so the "Restart Required" banner never clears and
# every restart attempt silently fails.
#
# Usage:
#   ./scripts/launch-dev.sh             # start the dev server in tmux
#   ./scripts/launch-dev.sh --kill      # kill the existing session first
#
# Why this exists: see BTCAAAAA-38750 triage notes — the inline launch
# was the root cause of the stuck "Restart Required" banner observed on
# 2026-06-30. Centralising the launch in this script makes the env
# contract a single-source-of-truth that future agents (and humans)
# can rely on.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_NAME="${PAPERCLIP_TMUX_SESSION:-paperclip}"
LOG_FILE="${PAPERCLIP_LOG_FILE:-/tmp/paperclip.log}"
NODE_BIN="${PAPERCLIP_NODE_BIN:-/home/sirrus/.nvm/versions/node/v24.16.0/bin}"

if [[ ! -x "$NODE_BIN/node" ]]; then
  echo "[launch-dev] WARN: $NODE_BIN/node not found; falling back to PATH" >&2
  NODE_BIN=""
fi

if [[ "${1:-}" == "--kill" ]]; then
  if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    tmux kill-session -t "$SESSION_NAME"
    echo "[launch-dev] killed existing session '$SESSION_NAME'"
  fi
fi

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "[launch-dev] session '$SESSION_NAME' is already running; attach with: tmux attach -t $SESSION_NAME" >&2
  exit 0
fi

cd "$REPO_ROOT"

# Build the env-prefix as a `VAR=value VAR=value` string. Each `VAR=value`
# before a command sets that var for the duration of that command. We
# use this pattern (instead of `export VAR=value`) because the inner
# tmux command runs under zsh (or sh) where we want a single
# deterministic command string.
ENV_PREFIX=""
if [[ -n "$NODE_BIN" ]]; then
  # Put the requested node bin at the FRONT of PATH so it wins over any
  # default Node v22 that the shell might have on PATH already. The dev
  # server depends on `node:sqlite` which only exists in v22.5+ (we use
  # v24.16.0 here); falling back to the system v22.12.0 produces the
  # "ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite" crash on first boot.
  ENV_PREFIX+="PATH='$NODE_BIN:$PATH' "
fi
ENV_PREFIX+="PAPERCLIP_HOME='/home/sirrus/.paperclip-worktrees' "

# Read the configured server port from config.json so the dev-runner's
# health-polling URL points at the right port. Without this the runner
# defaults to 3100 (its hardcoded fallback) and tries to poll the
# actual configured port (3101 / 3102 / ...), gets a connection
# refused, and aborts the restart cycle silently with "fetch failed".
SERVER_PORT=$(python3 -c "import json; print(json.load(open('$REPO_ROOT/.paperclip/config.json'))['server']['port'])")
ENV_PREFIX+="PORT='$SERVER_PORT' "

# Source the .env via `set -a` so every variable it sets is auto-exported
# into the tmux session.
set -a
# shellcheck disable=SC1091
. "$REPO_ROOT/.paperclip/.env"
set +a

# After the .env source, append PAPERCLIP_DEV_SERVER_STATUS_FILE explicitly
# to the env we'll export — this is the path the dev-runner polls and
# writes dirty-paths to, and which the server's /api/health reads back.
# Setting it explicitly defends against any future inline overrides.
export PAPERCLIP_DEV_SERVER_STATUS_FILE="$REPO_ROOT/.paperclip/dev-server-status.json"

# Compose the inline command. Note: NO override of
# PAPERCLIP_DEV_SERVER_STATUS_FILE after the .env source. This was the bug
# in previous launches. The first command (`PATH=... cd`) sets PATH for
# the cd builtin only; the subsequent `export PATH=...` makes the new
# PATH stick for every command in the shell session so pnpm/node pick
# up v24 first. PORT must also be exported explicitly — a leading
# `PORT=... cd` only sets it for the cd builtin, not for pnpm or its
# children (including the dev-runner, which reads PORT to compute its
# health-polling URL).
if [[ -n "$NODE_BIN" ]]; then
  EXPORT_PATH="export PATH='$NODE_BIN':\$PATH"
else
  EXPORT_PATH=""
fi

INNER_CMD="${ENV_PREFIX}cd '$REPO_ROOT' && "
INNER_CMD+="${EXPORT_PATH} && "
INNER_CMD+="export PORT='$SERVER_PORT' && "
INNER_CMD+="export PAPERCLIP_DEV_SERVER_STATUS_FILE='$REPO_ROOT/.paperclip/dev-server-status.json' && "
INNER_CMD+="pnpm dev:once 2>&1 | tee '$LOG_FILE'"

tmux new-session -d -s "$SESSION_NAME" "$INNER_CMD"
echo "[launch-dev] started session '$SESSION_NAME' (log: $LOG_FILE)"
echo "[launch-dev] attach with: tmux attach -t $SESSION_NAME"