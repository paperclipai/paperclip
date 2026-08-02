#!/usr/bin/env bash
# Controlled integration proof for TSMC-18987.
#
# The launchd wrapper deliberately kills incumbent :3100 listeners before
# starting.  Temporarily boot it out, hold :3100, run the *served* tree's
# normal `pnpm dev` command directly, then restore the wrapper unconditionally.
# macOS does not ship GNU `setsid`; keep this harness portable and terminate
# the direct pnpm parent during cleanup before restoring the managed service.
set -u

ROOT=/Users/glad0s/paperclip
OUT="$ROOT/work-products/TSMC-18923"
LABEL="ie.thinkstack.paperclip-source"
DOMAIN="gui/$(id -u)"
PLIST="/Users/glad0s/Library/LaunchAgents/${LABEL}.plist"
PORT=3100
WAIT_MS=30000
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="$OUT/restart-race-${STAMP}.log"
HEALTH="$OUT/restart-race-${STAMP}-health.json"
RESULT="$OUT/restart-race-${STAMP}-result.env"
HOLDER_PID=""
SERVER_PID=""
SERVICE_STOPPED=0

mkdir -p "$OUT"
exec > >(tee -a "$LOG") 2>&1

cleanup() {
  status=$?
  echo "[cleanup] status=$status"
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[cleanup] stopping direct served-tree dev process group $SERVER_PID"
    kill -TERM -- "-$SERVER_PID" 2>/dev/null || kill -TERM "$SERVER_PID" 2>/dev/null || true
    sleep 2
  fi
  if [ -n "$HOLDER_PID" ] && kill -0 "$HOLDER_PID" 2>/dev/null; then
    echo "[cleanup] stopping temporary holder $HOLDER_PID"
    kill -TERM "$HOLDER_PID" 2>/dev/null || true
  fi
  if [ "$SERVICE_STOPPED" = 1 ]; then
    echo "[cleanup] restoring managed source service"
    launchctl bootstrap "$DOMAIN" "$PLIST" 2>&1 || launchctl kickstart -k "$DOMAIN/$LABEL" 2>&1 || true
  fi
  echo "LOG=$LOG" > "$RESULT"
  echo "HEALTH=$HEALTH" >> "$RESULT"
  echo "RESULT=$RESULT" >> "$RESULT"
  exit "$status"
}
trap cleanup EXIT INT TERM

echo "[preflight] served_head=$(git -C "$ROOT" rev-parse HEAD)"
SERVED_SHORT="$(git -C "$ROOT" rev-parse --short=9 HEAD)"
git -C "$ROOT" merge-base --is-ancestor eda7c53dc HEAD
echo "[preflight] eda7c53dc is an ancestor of served HEAD"
echo "[preflight] initial health: $(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" | tr -d '\n')"

echo "[lifecycle] booting out managed source service $DOMAIN/$LABEL"
launchctl bootout "$DOMAIN/$LABEL"
SERVICE_STOPPED=1
for _ in $(seq 1 40); do
  lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
  sleep 0.25
done
if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[blocker] managed service did not release :$PORT"
  exit 20
fi

echo "[holder] binding :$PORT and releasing it after 8000ms"
node -e '
  const net=require("net");
  const server=net.createServer();
  server.listen({host:"127.0.0.1",port:3100},()=>{
    console.log("[holder] bound 3100");
    setTimeout(()=>server.close(()=>{console.log("[holder] released 3100"); process.exit(0)}),8000);
  });
  server.on("error", err=>{console.error("[holder] error",err);process.exit(2)});
' &
HOLDER_PID=$!
sleep 0.25
if ! kill -0 "$HOLDER_PID" 2>/dev/null; then
  echo "[blocker] temporary holder exited before direct server start"
  exit 21
fi

echo "[server] starting served tree's server entrypoint directly with PORT=$PORT PAPERCLIP_PORT_WAIT_MS=$WAIT_MS"
# Use the same TypeScript entrypoint the managed dev-watch child launches, while
# avoiding dev-watch's extra tsx supervisor IPC socket (the prior harness blocker).
(cd "$ROOT" && exec env PORT="$PORT" PAPERCLIP_PORT_WAIT_MS="$WAIT_MS" PAPERCLIP_MIGRATION_PROMPT=never PAPERCLIP_MIGRATION_AUTO_APPLY=true pnpm --filter @paperclipai/server exec tsx src/index.ts) &
SERVER_PID=$!

deadline=$((SECONDS + 35))
while [ "$SECONDS" -lt "$deadline" ]; do
  if grep -Fq "Requested port $PORT became available; binding it." "$LOG" 2>/dev/null && curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" > "$HEALTH"; then
    echo "[proof] health captured at $HEALTH"
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[blocker] direct served-tree dev process exited before proof"
    exit 22
  fi
  sleep 0.25
done

grep -F "Requested port $PORT is busy; waiting up to" "$LOG"
grep -F "Requested port $PORT became available; binding it." "$LOG"
test -s "$HEALTH"
node -e '
  const h=require(process.argv[1]);
  const expectedCommit=process.argv[2];
  if (h.status !== "ok" || h.instance?.commit !== expectedCommit) process.exit(3);
  console.log(`[proof] health status=${h.status} port=3100 servedCommit=${h.instance.commit} pid=${h.instance.pid}`);
' "$HEALTH" "$SERVED_SHORT"
echo "[proof] PASS"
