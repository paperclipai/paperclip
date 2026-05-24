#!/usr/bin/env bash
# Pod / container variant of designer-chrome.sh.
#
# Differences from the desktop launcher:
#   - Starts Xvfb on an internal :99 display before launching Chrome (containers
#     have no real display server, but Chrome on a virtual display is "headful"
#     to Cloudflare/Google bot-detection — unlike `--headless`).
#   - Runs Chrome with `--no-sandbox --disable-dev-shm-usage` (standard
#     container concessions; /dev/shm is typically 64M in k8s).
#   - Backgrounds Chrome with PID tracking so an entrypoint supervisor can
#     wait on it. Does not exec — caller is the supervisor.
#   - Expects DESIGNER_CHROME_PROFILE to point at a writable persisted dir
#     (PVC mount or a copy from a Secret-mounted bootstrap).
#
# Exit codes:
#   0  Chrome launched, CDP reachable on $DESIGNER_CDP. PID written to
#      $DESIGNER_PID_DIR/chrome.pid (default /run/designer/chrome.pid).
#   1  Misconfiguration (missing Chrome binary, missing profile, etc.)
#   2  CDP didn't come up within the timeout.

set -euo pipefail

PORT="${DESIGNER_CDP:-9222}"
PROFILE="${DESIGNER_CHROME_PROFILE:-/data/chrome-designer-profile}"
DISPLAY_NUM="${DESIGNER_DISPLAY:-:99}"
SCREEN_GEOM="${DESIGNER_SCREEN:-1920x1080x24}"
PID_DIR="${DESIGNER_PID_DIR:-/run/designer}"
CDP_TIMEOUT_S="${DESIGNER_CDP_TIMEOUT:-30}"

# Resolve Chrome binary (same logic as desktop script but Linux-only).
if [ -z "${CHROME_BIN:-}" ]; then
  for c in /usr/bin/google-chrome /usr/bin/google-chrome-stable /usr/bin/chromium /usr/bin/chromium-browser; do
    if [ -x "$c" ]; then CHROME_BIN="$c"; break; fi
  done
fi
CHROME="${CHROME_BIN:-/usr/bin/google-chrome}"

if [ ! -x "$CHROME" ]; then
  echo "[designer-chrome-pod] Chrome not found at: $CHROME" >&2
  echo "                       Set CHROME_BIN or install google-chrome / chromium in the image." >&2
  exit 1
fi
if [ ! -d "$PROFILE" ]; then
  echo "[designer-chrome-pod] Profile dir does not exist: $PROFILE" >&2
  echo "                       Bootstrap via Secret/PVC. See README pod section." >&2
  exit 1
fi

mkdir -p "$PID_DIR"

# Start Xvfb if no DISPLAY server is already advertising on $DISPLAY_NUM.
if ! pgrep -f "Xvfb $DISPLAY_NUM" >/dev/null 2>&1; then
  echo "[designer-chrome-pod] Starting Xvfb on $DISPLAY_NUM ($SCREEN_GEOM)"
  Xvfb "$DISPLAY_NUM" -screen 0 "$SCREEN_GEOM" -ac +extension RANDR +extension GLX >/dev/null 2>&1 &
  echo $! > "$PID_DIR/xvfb.pid"
  # Wait briefly for Xvfb to listen.
  for _ in 1 2 3 4 5; do
    if [ -e "/tmp/.X${DISPLAY_NUM#:}-lock" ]; then break; fi
    sleep 0.5
  done
fi

# Fast-path: someone (a sibling supervisor) may have already launched Chrome.
if curl -fs -o /dev/null "http://127.0.0.1:$PORT/json/version"; then
  echo "[designer-chrome-pod] CDP already listening on port $PORT — nothing to do."
  exit 0
fi

echo "[designer-chrome-pod] Launching Chrome on display $DISPLAY_NUM, CDP $PORT, profile $PROFILE"
DISPLAY="$DISPLAY_NUM" "$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=Translate,OptimizationHints \
  "https://claude.ai/design" \
  >/dev/null 2>&1 &
CHROME_PID=$!
echo "$CHROME_PID" > "$PID_DIR/chrome.pid"

# Wait for CDP to come up.
DEADLINE=$(( $(date +%s) + CDP_TIMEOUT_S ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if curl -fs -o /dev/null "http://127.0.0.1:$PORT/json/version"; then
    echo "[designer-chrome-pod] CDP up on :$PORT (chrome pid $CHROME_PID)"
    exit 0
  fi
  # Bail early if Chrome died.
  if ! kill -0 "$CHROME_PID" 2>/dev/null; then
    echo "[designer-chrome-pod] Chrome process $CHROME_PID exited before CDP came up." >&2
    exit 2
  fi
  sleep 0.5
done

echo "[designer-chrome-pod] CDP did not come up within ${CDP_TIMEOUT_S}s." >&2
exit 2
