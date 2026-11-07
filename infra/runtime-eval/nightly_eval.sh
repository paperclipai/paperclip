#!/usr/bin/env bash
# SAG-4193: Nightly eval runner — single-runner (flock), then digest + alert.
#
# Run by a Paperclip routine or on-box cron. Designed to be launched from a
# heartbeat as a detached background process so the heartbeat can exit while
# the ~2h GPU-bound eval continues.
#
# Usage (detached from heartbeat):
#   setsid nohup bash infra/runtime-eval/nightly_eval.sh >> infra/runtime-eval/results/nightly.log 2>&1 &
#
# Usage (foreground, for manual runs):
#   bash infra/runtime-eval/nightly_eval.sh
#
# Environment:
#   PAPERCLIP_API_URL  PAPERCLIP_API_KEY  PAPERCLIP_COMPANY_ID  PAPERCLIP_RUN_ID
#   EVAL_MODEL          (optional override, default gemma4:26b-a4b-it-q4_K_M)
#   EVAL_TIMEOUT_S      (optional, default 300)
#   NIGHTLY_EVAL_NOTIFY_ISSUE  (issue ID to post completion comment to, default SAG-4193)
#   TMP_HOUSEKEEPING_APPLY              (SAG-6346: default 0/dry-run; set 1 to actually delete)
#   TMP_HOUSEKEEPING_ROOT               (optional, default /tmp)
#   TMP_HOUSEKEEPING_PCVT_AGE_HOURS     (optional, default 12)
#   TMP_HOUSEKEEPING_WORKTREE_AGE_HOURS (optional, default 24)
#   LOCAL_AI_EVAL_SKIP_ON_PRESSURE      (optional, default 1)
#   LOCAL_AI_EVAL_MAX_QWEN_PROCS        (optional, default 0)
#   LOCAL_AI_EVAL_MAX_OPENCODE_PROCS    (optional, default 0)
#   LOCAL_AI_EVAL_MAX_LOADED_MODELS     (optional, default 0)
#   LOCAL_AI_EVAL_PREFLIGHT_ONLY        (optional test mode: run preflight then exit)
#   PRICING_STALENESS_DB_DSN            (optional; SAG-6327/SAG-6344 pricing staleness
#                                        detection runner. Unset = loud-fail skip, logged
#                                        but non-fatal to this pipeline.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"
LOCK_FILE="/tmp/sag4193-nightly-eval.lock"
LOG_FILE="$RESULTS_DIR/nightly.log"
NOTIFY_ISSUE="${NIGHTLY_EVAL_NOTIFY_ISSUE:-c8304ce0-3116-40b2-a718-4e7d0fb2c6d8}"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

mkdir -p "$RESULTS_DIR"
echo "$(ts) [nightly_eval] Starting — PID $$" >> "$LOG_FILE"

# ---------------------------------------------------------------------------
# Single-runner lock (SAG-3514 lesson: ONE runner, no daemon respawning)
# ---------------------------------------------------------------------------
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "$(ts) [nightly_eval] Already running (lock held). Exiting." >> "$LOG_FILE"
  exit 0
fi
echo "$(ts) [nightly_eval] Lock acquired." >> "$LOG_FILE"

# Ensure lock is released on exit (even on error)
trap 'flock -u 9; echo "$(ts) [nightly_eval] Lock released." >> "$LOG_FILE"' EXIT

# ---------------------------------------------------------------------------
# Non-destructive local-AI pressure guard (SAG-5279)
# ---------------------------------------------------------------------------
echo "$(ts) [nightly_eval] Running local-AI pressure preflight ..." >> "$LOG_FILE"
PREFLIGHT_EXIT=0
python3 "$SCRIPT_DIR/local_ai_pressure_preflight.py" >> "$LOG_FILE" 2>&1 || PREFLIGHT_EXIT=$?
if [ "$PREFLIGHT_EXIT" -eq 2 ]; then
  echo "$(ts) [nightly_eval] EVAL SKIPPED: local model pressure. run_eval.py was not started." >> "$LOG_FILE"
  if [ -n "${PAPERCLIP_API_URL:-}" ] && [ -n "${PAPERCLIP_API_KEY:-}" ]; then
    SKIP_BODY=$(printf '%s' '## Nightly Eval SKIPPED

EVAL SKIPPED: local model pressure. `run_eval.py` was not started; check `infra/runtime-eval/results/nightly.log` and the timestamped `local_ai_pressure_preflight_*.json` diagnostics artifact.' | python3 -c 'import json, sys; print(json.dumps({"body": sys.stdin.read()}))')
    curl -s -X POST "$PAPERCLIP_API_URL/api/issues/$NOTIFY_ISSUE/comments" \
      -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
      -H "Content-Type: application/json" \
      ${PAPERCLIP_RUN_ID:+-H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"} \
      -d "$SKIP_BODY" >> "$LOG_FILE" 2>&1 || true
  fi
  exit 0
elif [ "$PREFLIGHT_EXIT" -ne 0 ]; then
  echo "$(ts) [nightly_eval] Pressure preflight failed with code $PREFLIGHT_EXIT" >> "$LOG_FILE"
  exit "$PREFLIGHT_EXIT"
fi

if [ "${LOCAL_AI_EVAL_PREFLIGHT_ONLY:-0}" = "1" ]; then
  echo "$(ts) [nightly_eval] LOCAL_AI_EVAL_PREFLIGHT_ONLY=1; exiting before run_eval.py." >> "$LOG_FILE"
  exit 0
fi

# ---------------------------------------------------------------------------
# Run eval
# ---------------------------------------------------------------------------
echo "$(ts) [nightly_eval] Running run_eval.py ..." >> "$LOG_FILE"
EVAL_EXIT=0
python3 "$SCRIPT_DIR/run_eval.py" >> "$LOG_FILE" 2>&1 || EVAL_EXIT=$?

if [ $EVAL_EXIT -ne 0 ]; then
  echo "$(ts) [nightly_eval] run_eval.py exited with code $EVAL_EXIT" >> "$LOG_FILE"
  # Post failure notice if API is available
  if [ -n "${PAPERCLIP_API_URL:-}" ] && [ -n "${PAPERCLIP_API_KEY:-}" ]; then
    FAIL_BODY=$(python3 -c "import json; print(json.dumps({'body': '## Nightly Eval FAILED\n\nrun_eval.py exited with code $EVAL_EXIT. Check \`infra/runtime-eval/results/nightly.log\` for details.\n\n[@CTO](agent://f3c48afc-c339-4e43-b47b-a42a0891229d)'}))")
    curl -s -X POST "$PAPERCLIP_API_URL/api/issues/$NOTIFY_ISSUE/comments" \
      -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
      -H "Content-Type: application/json" \
      ${PAPERCLIP_RUN_ID:+-H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"} \
      -d "$FAIL_BODY" >> "$LOG_FILE" 2>&1 || true
  fi
  exit $EVAL_EXIT
fi

echo "$(ts) [nightly_eval] run_eval.py complete. Running digest_and_alert.py ..." >> "$LOG_FILE"

# ---------------------------------------------------------------------------
# Digest + alert
# ---------------------------------------------------------------------------
DIGEST_EXIT=0
python3 "$SCRIPT_DIR/digest_and_alert.py" >> "$LOG_FILE" 2>&1 || DIGEST_EXIT=$?

echo "$(ts) [nightly_eval] digest_and_alert.py exited with code $DIGEST_EXIT" >> "$LOG_FILE"

if [ $DIGEST_EXIT -ne 0 ]; then
  echo "$(ts) [nightly_eval] Digest/alert step failed (see log). Eval results are still in $RESULTS_DIR." >> "$LOG_FILE"
fi

# ---------------------------------------------------------------------------
# /tmp housekeeping (SAG-6346) — dry-run by default; never blocks nightly exit.
# Set TMP_HOUSEKEEPING_APPLY=1 to enable real deletion once dry-run logs look right.
# ---------------------------------------------------------------------------
echo "$(ts) [nightly_eval] Running tmp_housekeeping.py (apply=${TMP_HOUSEKEEPING_APPLY:-0}) ..." >> "$LOG_FILE"
HOUSEKEEPING_EXIT=0
python3 "$SCRIPT_DIR/tmp_housekeeping.py" >> "$LOG_FILE" 2>&1 || HOUSEKEEPING_EXIT=$?
echo "$(ts) [nightly_eval] tmp_housekeeping.py exited with code $HOUSEKEEPING_EXIT" >> "$LOG_FILE"

# ---------------------------------------------------------------------------
# Pricing staleness detection (SAG-6327 Phase 3+4 / SAG-6344)
#
# Independent of the local-AI eval above. Exits 0 both on a clean detection
# run and on the expected pending-dependency state (real rate feeds still
# pending, SAG-6341/SAG-6343 — Phase 1's alerts table already landed in
# migration 003, commit b35be578) — it never fails nightly_eval.sh. A
# non-zero exit here means an unexpected error, which is logged but still
# does not abort the unrelated eval/digest steps above.
# ---------------------------------------------------------------------------
echo "$(ts) [nightly_eval] Running pricing_staleness_runner.py ..." >> "$LOG_FILE"
STALENESS_EXIT=0
python3 "$SCRIPT_DIR/pricing_staleness_runner.py" >> "$LOG_FILE" 2>&1 || STALENESS_EXIT=$?
echo "$(ts) [nightly_eval] pricing_staleness_runner.py exited with code $STALENESS_EXIT" >> "$LOG_FILE"

# Post completion notice to the routine issue
if [ -n "${PAPERCLIP_API_URL:-}" ] && [ -n "${PAPERCLIP_API_KEY:-}" ]; then
  LATEST=$(ls -t "$RESULTS_DIR"/*.json 2>/dev/null | head -1 || echo "(none)")
  STATUS_MSG="✅ Nightly eval complete. Latest results: \`$(basename "$LATEST")\`. Digest posted to [SAG-3196](/SAG/issues/SAG-3196)."
  if [ $DIGEST_EXIT -ne 0 ]; then
    STATUS_MSG="⚠️ Eval complete but digest/alert step failed (exit $DIGEST_EXIT). Latest results: \`$(basename "$LATEST")\`. Check \`nightly.log\`."
  fi
  DONE_BODY=$(python3 -c "import json; print(json.dumps({'body': '$STATUS_MSG'}))")
  curl -s -X POST "$PAPERCLIP_API_URL/api/issues/$NOTIFY_ISSUE/comments" \
    -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
    -H "Content-Type: application/json" \
    ${PAPERCLIP_RUN_ID:+-H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"} \
    -d "$DONE_BODY" >> "$LOG_FILE" 2>&1 || true
fi

echo "$(ts) [nightly_eval] Done." >> "$LOG_FILE"
exit 0
