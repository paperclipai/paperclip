#!/usr/bin/env bash
set -euo pipefail

if ! command -v higgsfield >/dev/null 2>&1; then
  echo "FAIL: higgsfield CLI is not installed or not on PATH" >&2
  exit 3
fi

status_json="$(higgsfield account status --json 2>&1)" || {
  echo "FAIL: Higgsfield OAuth CLI is not authenticated or account status failed" >&2
  echo "$status_json" >&2
  exit 4
}

cost_json="$(higgsfield generate cost nano_banana_2 --prompt test --json 2>&1)" || {
  echo "FAIL: Higgsfield OAuth CLI authenticated, but cost probe failed" >&2
  echo "$cost_json" >&2
  exit 5
}

python3 - <<'PY' "$status_json" "$cost_json"
import json, sys
status=json.loads(sys.argv[1])
cost=json.loads(sys.argv[2])
credits=float(status.get('credits') or 0)
est=float(cost.get('credits') or 0)
print('SUCCESS: Higgsfield OAuth CLI is authenticated and generation credits are available.')
print(f"Evidence: account={status.get('email')} plan={status.get('subscription_plan_type')} credits={credits} cost_probe={est}")
if credits < est:
    print('Blocker: credits are below probe estimate; add credits before generation.')
    sys.exit(2)
PY
