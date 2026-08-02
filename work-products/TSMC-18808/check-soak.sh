#!/usr/bin/env bash
# TSMC-18808 soak check — run on monitor wake.
# Exit 0 + SOAK_PASS when unexpected-exit counter still equals baseline 218
# and wall-clock >= 2h from board baseline (caps=4 restore).
set -euo pipefail

# Prefer absolute path; hermes homes do not mirror ~/paperclip.
LOG="${PAPERCLIP_LAUNCHD_ERR_LOG:-/Users/glad0s/paperclip/.devlogs/launchd.err.log}"
BASELINE="${SOAK_BASELINE_EXITS:-218}"
# Board baseline: caps restored 2026-08-01 03:46:23 IST (UTC+1) / counter 218 after that restart.
BASELINE_EPOCH="${SOAK_BASELINE_EPOCH:-1785552383}"
NOW_EPOCH=$(date +%s)
ELAPSED=$((NOW_EPOCH - BASELINE_EPOCH))
EXITS=$(grep -c 'exited unexpectedly' "$LOG" || true)
EPIPE=$(grep -c 'Error: write EPIPE' "$LOG" || true)
LAST_EXIT=$(grep 'exited unexpectedly' "$LOG" | tail -1 || true)
API_CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3100/api/health || echo 000)

POST_EXITS=$(LOG_PATH="$LOG" python3 - <<'PY'
import os
from pathlib import Path
lines = Path(os.environ["LOG_PATH"]).read_text(errors="replace").splitlines()
idx = next((i for i, ln in enumerate(lines) if "launchd-start 03:46:18" in ln and "cleanup complete" in ln), None)
if idx is None:
    print(-1)
else:
    print(sum(1 for ln in lines[idx:] if "exited unexpectedly" in ln))
PY
)

echo "exits=$EXITS baseline=$BASELINE post_baseline_exits=$POST_EXITS epipe_total=$EPIPE elapsed_s=$ELAPSED api=$API_CODE"
echo "last_exit_line=$LAST_EXIT"
echo "log=$LOG"

if [[ "$EXITS" -eq "$BASELINE" && "$POST_EXITS" -eq 0 && "$ELAPSED" -ge 7200 && "$API_CODE" == "200" ]]; then
  echo "SOAK_PASS"
  exit 0
elif [[ "$EXITS" -gt "$BASELINE" || "$POST_EXITS" -gt 0 ]]; then
  echo "SOAK_FAIL counter_moved"
  exit 2
elif [[ "$ELAPSED" -lt 7200 ]]; then
  echo "SOAK_INCOMPLETE need_more_time remaining_s=$((7200 - ELAPSED))"
  exit 3
else
  echo "SOAK_FAIL other"
  exit 4
fi
