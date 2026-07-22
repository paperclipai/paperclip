#!/usr/bin/env bash
# CK cadence keeper — runs the evaluation pass and (weekly) the live tactical meeting so the CK
# Evaluation + CK Meeting Room pages stay fresh. Runs the scripts inside the pc-build container
# (where node/tsx + the DeepSeek key live). NOTE: this is a stopgap host cron; the native-first
# upgrade is to fold these into plugin jobs (JOB_EVAL_SYNC + un-defer the live meeting IDS), which
# needs a server restart — currently BLOCKED on the missing /work/.pc-master.key.
set -euo pipefail
MODE="${1:-eval}"
DBURL="postgres://paperclip:ckP4perclipLocal_2026@127.0.0.1:5432/ck_workforce"
LOG=/work/.ck-agent

case "$MODE" in
  eval)
    docker exec pc-build node /work/.ck-agent/eval-sync.mjs >> ~/paperclip/.ck-agent/eval-cron.log 2>&1
    ;;
  meeting)
    docker exec -w /work/packages/plugins/plugin-ck-office pc-build sh -c \
      "DATABASE_URL='$DBURL' DEEPSEEK_API_KEY=\"\$(cat /work/.ck-secrets/deepseek.key)\" \
       /work/server/node_modules/.bin/tsx src/meeting/meeting-live-ck.ts" \
      >> ~/paperclip/.ck-agent/meeting-cron.log 2>&1
    ;;
  *) echo "usage: $0 {eval|meeting}"; exit 2;;
esac
