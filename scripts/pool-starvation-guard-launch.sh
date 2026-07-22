#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${POOL_STARVATION_GUARD_ENV:-$ROOT/.secrets/pool-starvation-guard.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

: "${DATABASE_URL:?DATABASE_URL is required}"

exec "$ROOT/scripts/pool_starvation_guard.py" \
  --state-path "${POOL_STARVATION_GUARD_STATE_PATH:-$ROOT/scratch/pool-starvation-guard-state.json}" \
  --report-path "${POOL_STARVATION_GUARD_REPORT_PATH:-$ROOT/docs/pool-starvation-guard-report.json}" \
  --pool-size "${POOL_STARVATION_GUARD_POOL_SIZE:-10}" \
  --threshold-percent "${POOL_STARVATION_GUARD_THRESHOLD_PERCENT:-80}" \
  --idle-transaction-seconds "${POOL_STARVATION_GUARD_IDLE_TRANSACTION_SECONDS:-60}" \
  --cooldown-seconds "${POOL_STARVATION_GUARD_COOLDOWN_SECONDS:-900}" \
  --launchd-label "${POOL_STARVATION_GUARD_LAUNCHD_LABEL:-ie.thinkstack.paperclip-source}" \
  ${POOL_STARVATION_GUARD_DRY_RUN:+--dry-run}
