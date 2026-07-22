#!/usr/bin/env bash
# pc-server-up.sh — ensure the Paperclip server (inside pc-build) is running; relaunch if not.
# Idempotent: healthy -> no-op; down -> relaunch + wait for health.
# Pass --restart to replace a healthy source runtime before live verification.
# Pass --stop only for controlled recovery tests; the watchdog will restore it.
# The DB password is read from the pc-postgres container AT RUNTIME — no secret is stored in this file.
# Used by a watchdog (timer/service) so Paperclip survives crashes, container restarts, and host reboots.
set -uo pipefail

HEALTH="http://127.0.0.1:3100/api/health"
LOG="$HOME/paperclip/.ck-agent/pc-server.log"
ACTION="${1:-}"

# Already healthy? nothing to do unless explicit source activation was requested.
if curl -sf --max-time 5 "$HEALTH" >/dev/null 2>&1 && [ "$ACTION" != "--restart" ] && [ "$ACTION" != "--stop" ]; then
  exit 0
fi

if [ "$ACTION" = "--restart" ] || [ "$ACTION" = "--stop" ]; then
  action_label="restarting"
  [ "$ACTION" = "--stop" ] && action_label="stopping"
  echo "$(date -Is) gracefully ${action_label} paperclip server" | tee -a "$LOG" >&2
  # Match the tsx CLI path, not the shell wrapper (whose argv may contain
  # credentials). The bracketed slash keeps pkill from matching itself.
  docker exec pc-build sh -lc "pkill -TERM -f '[/]tsx/.+src/index.ts' || true" >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do
    if ! curl -sf --max-time 1 "$HEALTH" >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
  if curl -sf --max-time 1 "$HEALTH" >/dev/null 2>&1; then
    echo "$(date -Is) server did not stop gracefully" | tee -a "$LOG" >&2
    exit 1
  fi
  if [ "$ACTION" = "--stop" ]; then
    echo "$(date -Is) paperclip server stopped" | tee -a "$LOG" >&2
    exit 0
  fi
fi

echo "$(date -Is) paperclip server not healthy — (re)launching" | tee -a "$LOG" >&2

# Make sure the container is up (restart policy should bring it back after a reboot).
if ! docker ps --format '{{.Names}}' | grep -qx pc-build; then
  docker start pc-build >/dev/null 2>&1 || { echo "pc-build not startable"; exit 1; }
  sleep 2
fi

# Read the DB password from pc-postgres at runtime (not persisted here).
PGPW="$(docker inspect pc-postgres --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^POSTGRES_PASSWORD=//p')"
[ -n "$PGPW" ] || { echo "cannot read DB password from pc-postgres — aborting"; exit 1; }

# Launch the server detached inside the container with the minimal correct env
# (deploymentMode local_trusted + serveUi + port 3100 are the code defaults).
docker exec -d pc-build sh -c "cd /work && \
  DATABASE_URL='postgres://paperclip:${PGPW}@127.0.0.1:5432/ck_workforce' \
  PORT=3100 PAPERCLIP_TELEMETRY_DISABLED=1 \
  CK_ESPO_SEND_LIVE=1 \
  PAPERCLIP_SECRETS_MASTER_KEY_FILE=/work/.pc-master.key \
  PAPERCLIP_ALLOWED_HOSTNAMES='quita-divino,quita-divino.tail86580f.ts.net,100.94.48.41,localhost,127.0.0.1' \
  nohup pnpm --filter @paperclipai/server dev >> /work/.ck-agent/pc-server.log 2>&1"

# Wait up to ~90s for health.
for i in $(seq 1 30); do
  sleep 3
  if curl -sf --max-time 5 "$HEALTH" >/dev/null 2>&1; then
    echo "$(date -Is) server healthy after ~$((i * 3))s" | tee -a "$LOG" >&2
    exit 0
  fi
done
echo "$(date -Is) server did NOT become healthy within 90s — see $LOG" | tee -a "$LOG" >&2
exit 1
