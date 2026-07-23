#!/bin/bash
# Boots Paperclip as the non-root `paperclip` user (embedded Postgres
# refuses to run as root). Onboards once, then runs the server.
set -euo pipefail

chown -R paperclip:paperclip /paperclip

exec runuser -u paperclip -- bash -lc '
  set -euo pipefail
  export HOME=/home/paperclip
  if [ ! -f /paperclip/instances/default/config.json ]; then
    paperclipai onboard --yes --bind lan --data-dir /paperclip
  fi
  exec paperclipai run --data-dir /paperclip
'
