#!/usr/bin/env bash
set -euo pipefail
SERVED="/Users/glad0s/.paperclip/instances/default/projects/e212ce50-b524-408c-b3d4-0c6108d8c2e2/f71e8665-3f38-4920-b777-348ec85b9071/_default"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
RUN_ROOT="$SERVED/work-products/TSBC-1171/runs/r2-ambiguous-ownership-clarify"
REF_HOME="$SERVED/work-products/TSBC-1330/hermes-xai-auth-reference/.hermes"
RUNTIME_HOME="$RUN_ROOT/hermes-home-resume-$STAMP/.hermes"
DUR_TMP="$SERVED/work-products/TSBC-1529/tmp"
LOG="$SERVED/work-products/TSBC-1529/logs/r2-resume-$STAMP.log"
mkdir -p "$RUNTIME_HOME" "$DUR_TMP" "$(dirname "$LOG")" \
  "$SERVED/work-products/TSBC-1536"

for name in .env auth auth.json config.yaml; do
  ln -snf "$REF_HOME/$name" "$RUNTIME_HOME/$name"
done

export HERMES_HOME="$RUNTIME_HOME"
export HERMES_IGNORE_RULES=1
export TMPDIR="$DUR_TMP"
export TMP="$DUR_TMP"
export TEMP="$DUR_TMP"
export PAPERCLIP_TMPDIR="$DUR_TMP"
# Prevent ephemeral paperclip scratch from being preferred
unset PAPERCLIP_SCRATCH_DIR PAPERCLIP_RUN_SCRATCH_DIR || true

echo "resume HERMES_HOME=$HERMES_HOME" | tee -a "$LOG"
echo "resume TMPDIR=$TMPDIR" | tee -a "$LOG"
echo "log=$LOG" | tee -a "$LOG"

cd /Users/glad0s/paperclip/benchmark
python3 "$SERVED/work-products/TSBC-1536/resume_r2_missing_five.py" 2>&1 | tee -a "$LOG"
ec=${PIPESTATUS[0]}
echo "EXIT_CODE=$ec" | tee -a "$LOG"
exit "$ec"
