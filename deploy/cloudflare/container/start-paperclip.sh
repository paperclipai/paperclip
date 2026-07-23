#!/bin/bash
# Boots Paperclip as the non-root `paperclip` user (embedded Postgres refuses
# to run as root). Onboards non-interactively on first boot, then runs the
# server. Started by the Worker via sandbox.startProcess() with the runtime
# environment (PAPERCLIP_*, optional ANTHROPIC_API_KEY / DATABASE_URL) —
# runuser without --login preserves that environment for the child shell.
set -euo pipefail

# Own the data dir, but skip the (optional) R2-mounted storage directory:
# s3fs rejects chown, which would abort the boot under `set -e`. The mount
# is already exposed with the paperclip uid via s3fs options (src/lib.ts).
find /paperclip -path /paperclip/instances/default/data/storage -prune \
  -o -exec chown paperclip:paperclip {} +

exec runuser -u paperclip -- bash -c '
  set -euo pipefail
  export HOME=/home/paperclip
  if [ ! -f /paperclip/instances/default/config.json ]; then
    paperclipai onboard --yes --bind lan --data-dir /paperclip
  fi
  exec paperclipai run --data-dir /paperclip
'
