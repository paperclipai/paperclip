#!/usr/bin/env bash
# Launch a Chrome instance with remote debugging enabled, in a dedicated
# user-data-dir so the default profile's debug-port lockdown (Chrome 136+)
# doesn't block us. Sign in to Claude once inside the launched window;
# the profile persists.

set -e

PORT="${DESIGNER_CDP:-9222}"
PROFILE="${DESIGNER_CHROME_PROFILE:-$HOME/.chrome-designer-profile}"

# Resolve Chrome binary per-OS if CHROME_BIN not set.
if [ -z "${CHROME_BIN:-}" ]; then
  case "$(uname -s)" in
    Darwin)
      CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      ;;
    Linux)
      for c in /usr/bin/google-chrome /usr/bin/chromium /usr/bin/chromium-browser; do
        if [ -x "$c" ]; then CHROME_BIN="$c"; break; fi
      done
      ;;
  esac
fi
CHROME="${CHROME_BIN:-/usr/bin/google-chrome}"

if [ ! -x "$CHROME" ]; then
  echo "[designer-chrome] Chrome not found at: $CHROME" >&2
  echo "                  Set CHROME_BIN to override." >&2
  exit 1
fi

if curl -fs -o /dev/null "http://127.0.0.1:$PORT/json/version"; then
  echo "[designer-chrome] CDP already listening on port $PORT — nothing to do."
  echo "                  curl http://127.0.0.1:$PORT/json/version | head"
  exit 0
fi

if pgrep -f "Google Chrome" >/dev/null; then
  echo "[designer-chrome] WARNING: Chrome is already running." >&2
  echo "                  If it's NOT a debug-mode Chrome, the launched window may not get the debug port." >&2
  echo "                  Quit existing Chrome (Cmd+Q) first, or accept the risk and continue." >&2
fi

echo "[designer-chrome] Launching: $CHROME --remote-debugging-port=$PORT --user-data-dir=$PROFILE"
echo "[designer-chrome] Sign in to claude.ai in the new window. Then navigate to https://claude.ai/design."
echo "[designer-chrome] When done, leave this window open. The CDP server runs as long as Chrome runs."

exec "$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  "https://claude.ai/design"
