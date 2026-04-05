#!/usr/bin/env bash
# Patch: Telegram plugin non-blocking initialize
# The plugin's setup() awaits setMyCommands() — a remote HTTP call to
# api.telegram.org — before completing initialization. If Telegram is
# slow/unreachable, setup() blocks past the host's 15s worker-init RPC
# timeout and the worker is SIGKILLed before it can start polling.
#
# Fix: fire-and-forget the setMyCommands() call so setup() returns fast.
# Commands still get registered on every worker start; if the call fails,
# it logs an error and the next worker start retries. This matches the
# pattern already used by pollUpdates() below it.
#
# Upstream: github.com/mvanhorn/paperclip-plugin-telegram (src/worker.ts)

set -euo pipefail

PAPERCLIP_HOME_DIR="${PAPERCLIP_HOME:-$HOME/.paperclip}"
TARGET_WORKER="${PAPERCLIP_HOME_DIR}/plugins/node_modules/paperclip-plugin-telegram/dist/worker.js"

if [ ! -f "$TARGET_WORKER" ]; then
  echo "Telegram plugin not installed — skipping patch"
  exit 0
fi

if grep -q "Non-blocking init: don't hold up worker initialize" "$TARGET_WORKER" 2>/dev/null; then
  echo "Patch already applied: telegram-plugin-nonblocking-init"
  exit 0
fi

python3 - "$TARGET_WORKER" << 'PY'
import sys
worker_path = sys.argv[1]

with open(worker_path, 'r') as f:
    worker = f.read()

worker_old = """            const registered = await setMyCommands(ctx, token, allCommands);
            if (registered) {
                ctx.logger.info("Bot commands registered with Telegram");
            }"""

worker_new = """            // Non-blocking init: don't hold up worker initialize on external API.
            setMyCommands(ctx, token, allCommands)
                .then((registered) => {
                    if (registered) {
                        ctx.logger.info("Bot commands registered with Telegram");
                    }
                })
                .catch((err) => {
                    ctx.logger.error("Failed to register bot commands", { error: String(err) });
                });"""

if worker_old in worker:
    worker = worker.replace(worker_old, worker_new)
    with open(worker_path, 'w') as f:
        f.write(worker)
    print("Worker patch: applied (non-blocking setMyCommands in setup())")
else:
    # Pattern absent may mean the plugin was upgraded past the broken version
    # (e.g. mvanhorn/paperclip-plugin-telegram#19 merged upstream) — don't fail
    # pnpm dev on that case; just warn so operators can prune the patch.
    print("Worker patch: WARN — expected pattern not found, nothing changed")
PY
