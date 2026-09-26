#!/usr/bin/env bash
# Probes Cloudflare API auth state for the Turnstile Spin agent.
#
# Reads:
#   $CLOUDFLARE_API_TOKEN  (required)
#   $CLOUDFLARE_ACCOUNT_ID (optional; if set, must be one of the token's accounts)
#
# Requires: bash, curl, python3. Optional: a user-approved WRANGLER_BIN for account enumeration.
#
# Outputs JSON to stdout, always exits 0. The agent reads `status`:
#   "ok"                ; selected account passed the Turnstile Edit-scope probe
#   "missing_token"     ; no token set, python3 unavailable, or account enumeration failed
#   "missing_scope"     ; token lacks Account.Turnstile:Edit on the selected account
#   "multiple_accounts" ; token covers >1 accounts and $CLOUDFLARE_ACCOUNT_ID is unset
#   "account_mismatch"  ; $CLOUDFLARE_ACCOUNT_ID is set but is not in the token's accounts list
#   "network_failure"   ; the Edit-scope probe could not reach the Cloudflare API
#   "upstream_failure"  ; the Edit-scope probe returned an unexpected upstream response
#
# Account enumeration uses `WRANGLER_BIN whoami --json` only when WRANGLER_BIN is
# an approved canonical absolute path outside PROJECT_ROOT and WRANGLER_VERSION
# matches it exactly. Otherwise the caller must supply $CLOUDFLARE_ACCOUNT_ID.
#
# Human-readable diagnostics go to stderr.

set +x
set -uo pipefail

emit() {
  echo "$1"
  exit 0
}

if ! command -v python3 >/dev/null 2>&1; then
  echo "auth-probe: python3 is required but not found in PATH." >&2
  emit '{"status":"missing_token","reason":"python3_not_available"}'
fi

token="${CLOUDFLARE_API_TOKEN:-}"
unset CLOUDFLARE_API_TOKEN
declared_account="${CLOUDFLARE_ACCOUNT_ID:-}"

if [ -z "$token" ]; then
  echo "auth-probe: \$CLOUDFLARE_API_TOKEN is not set." >&2
  emit '{"status":"missing_token","reason":"no_env_var"}'
fi
if [[ ! "$token" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "auth-probe: CLOUDFLARE_API_TOKEN has an invalid format." >&2
  emit '{"status":"missing_token","reason":"invalid_token_format"}'
fi

accounts_json=""
account_count=0

if [ -n "${WRANGLER_BIN:-}" ]; then
  if [[ "$WRANGLER_BIN" != /* || ! -x "$WRANGLER_BIN" ]]; then
    echo "auth-probe: WRANGLER_BIN must be an executable absolute path." >&2
    emit '{"status":"missing_token","reason":"invalid_wrangler_path"}'
  fi

  wrangler_bin=$(python3 -I -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$WRANGLER_BIN")
  if [ "$wrangler_bin" != "$WRANGLER_BIN" ]; then
    echo "auth-probe: WRANGLER_BIN must be canonical, without symlinks." >&2
    emit '{"status":"missing_token","reason":"noncanonical_wrangler_path"}'
  fi
  if [ -n "${PROJECT_ROOT:-}" ]; then
    project_root=$(python3 -I -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$PROJECT_ROOT")
    if [[ "$wrangler_bin" == "$project_root" || "$wrangler_bin" == "$project_root/"* ]]; then
      echo "auth-probe: WRANGLER_BIN must be outside PROJECT_ROOT." >&2
      emit '{"status":"missing_token","reason":"project_local_wrangler"}'
    fi
  fi
  if [ -z "${WRANGLER_VERSION:-}" ]; then
    echo "auth-probe: WRANGLER_VERSION is required with WRANGLER_BIN." >&2
    emit '{"status":"missing_token","reason":"missing_wrangler_version"}'
  fi

  actual_version=$(
    "$wrangler_bin" --version 2>/dev/null |
      python3 -I -c 'import re,sys; m=re.search(r"\b(\d+\.\d+\.\d+)\b", sys.stdin.read()); print(m.group(1) if m else "")'
  )
  if [ "$actual_version" != "$WRANGLER_VERSION" ]; then
    echo "auth-probe: WRANGLER_BIN version does not match WRANGLER_VERSION." >&2
    emit '{"status":"missing_token","reason":"wrangler_version_mismatch"}'
  fi

  whoami_json=$(CLOUDFLARE_API_TOKEN="$token" "$wrangler_bin" whoami --json 2>/dev/null || true)
  if [ -n "$whoami_json" ] && [ "$(printf '%s' "$whoami_json" | head -c 1)" = "{" ]; then
    accounts_json=$(printf '%s' "$whoami_json" | python3 -I -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print(json.dumps(d.get("accounts") or []))
except Exception:
    print("[]")
')
    account_count=$(printf '%s' "$accounts_json" | python3 -I -c '
import json, sys
try:
    print(len(json.load(sys.stdin)))
except Exception:
    print(0)
')
  fi
fi

if [ "$account_count" = "0" ] && [ -n "$declared_account" ]; then
  # No wrangler, but user gave us an account. Trust it and skip enumeration.
  accounts_json="[{\"id\":$(python3 -I -c 'import json, sys; print(json.dumps(sys.argv[1]))' "$declared_account")}]"
  account_count=1
fi

if [ "$account_count" = "0" ]; then
  echo "auth-probe: could not enumerate accounts. Export CLOUDFLARE_ACCOUNT_ID or provide an approved WRANGLER_BIN and WRANGLER_VERSION." >&2
  emit '{"status":"missing_token","reason":"no_accounts"}'
fi

if [ -n "$declared_account" ]; then
  in_list=$(printf '%s' "$accounts_json" | python3 -I -c '
import json, sys
target = sys.argv[1]
try:
    accounts = json.load(sys.stdin)
except Exception:
    print("false"); sys.exit(0)
print("true" if any((a or {}).get("id") == target for a in accounts) else "false")
' "$declared_account")
  if [ "$in_list" != "true" ]; then
    echo "auth-probe: \$CLOUDFLARE_ACCOUNT_ID ($declared_account) is not one of the token's accounts." >&2
    emit "$(python3 -I -c '
import json, sys
declared, accounts_raw = sys.argv[1], sys.argv[2]
try:
    accounts = json.loads(accounts_raw)
except Exception:
    accounts = []
print(json.dumps({"status":"account_mismatch","declared":declared,"accounts":accounts}))
' "$declared_account" "$accounts_json")"
  fi
  account_id="$declared_account"
elif [ "$account_count" = "1" ]; then
  account_id=$(printf '%s' "$accounts_json" | python3 -I -c '
import json, sys
try:
    print(json.load(sys.stdin)[0]["id"])
except Exception:
    print("")
')
  if [ -z "$account_id" ]; then
    echo "auth-probe: accounts list had one entry but no id field." >&2
    emit '{"status":"missing_token","reason":"malformed_accounts"}'
  fi
else
  echo "auth-probe: token covers $account_count accounts; ask the user to pick one, then export \$CLOUDFLARE_ACCOUNT_ID and re-run." >&2
  emit "$(python3 -I -c '
import json, sys
try:
    accounts = json.loads(sys.argv[1])
except Exception:
    accounts = []
print(json.dumps({"status":"multiple_accounts","accounts":accounts}))
' "$accounts_json")"
fi

# Edit-scope probe. A GET /challenges/widgets would authorize a Read-only
# token; to verify Edit specifically, POST with an intentionally invalid
# payload and interpret the response:
#   401 or 403                                  → token lacks Edit
#   200 with success:false, errors[0].code=10000 → token lacks Edit
#   400/422 or 200 with validation error codes  → Edit scope OK
#
# The API rejects the empty-name/empty-domains payload with 400 today, so
# no widget is created. If validation ever loosens and the probe accidentally
# creates one, we detect the returned sitekey and DELETE it as a safety net
# so the probe stays side-effect-free.
account_enc=$(python3 -I -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$account_id")

if ! probe_response="$(
  printf 'header = "Authorization: Bearer %s"\n' "$token" |
    curl --disable --config - --silent --show-error --write-out $'\n%{http_code}' -X POST \
      "https://api.cloudflare.com/client/v4/accounts/$account_enc/challenges/widgets" \
      -H "Content-Type: application/json" \
      --data '{"name":"","domains":[]}'
)"; then
  echo "auth-probe: network failure probing Edit scope on account $account_id." >&2
  emit '{"status":"network_failure","account_id":"'"$account_id"'"}'
fi

edit_code="${probe_response##*$'\n'}"
probe_body="${probe_response%$'\n'*}"
probe_output=$(printf '%s' "$probe_body" | python3 -I -c '
import json, sys
http_code = sys.argv[1]
verdict = "unknown"
created_sitekey = ""
try:
    raw = sys.stdin.read()
    data = json.loads(raw) if raw else {}
except Exception:
    data = None
if isinstance(data, dict):
    errors = data.get("errors") or []
    if not isinstance(errors, list):
        errors = []
    first = (errors[0] or {}) if errors else {}
    if not isinstance(first, dict):
        first = {}
    first_code = first.get("code", 0)
    if http_code in ("401", "403"):
        verdict = "missing_scope"
    elif http_code == "200" and data.get("success") is False and first_code == 10000:
        verdict = "missing_scope"
    elif http_code in ("400", "422"):
        verdict = "scope_ok"
    elif http_code == "200":
        # Any 200 that got past auth means scope is fine (whether success or not).
        verdict = "scope_ok"
    else:
        verdict = f"unexpected_{http_code}"
    # Detect accidental widget creation (safety net if API validation ever
    # accepts the empty-name/empty-domains probe payload).
    result = data.get("result")
    if isinstance(result, dict) and data.get("success") is True:
        sk = result.get("sitekey", "")
        if isinstance(sk, str) and sk:
            created_sitekey = sk
print(f"{verdict}|{created_sitekey}")
' "$edit_code")
unset probe_body probe_response
verdict="${probe_output%%|*}"
created_sitekey="${probe_output#*|}"
[ "$created_sitekey" = "$probe_output" ] && created_sitekey=""

# If the probe unexpectedly created a widget (API validation loosened),
# DELETE it so the probe stays side-effect-free.
if [ -n "$created_sitekey" ]; then
  echo "auth-probe: probe unexpectedly created widget $created_sitekey; cleaning up..." >&2
  sk_enc=$(python3 -I -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$created_sitekey")
  cleanup_code=$(
    printf 'header = "Authorization: Bearer %s"\n' "$token" |
      curl --disable --config - --silent --show-error --output /dev/null --write-out "%{http_code}" -X DELETE \
        "https://api.cloudflare.com/client/v4/accounts/$account_enc/challenges/widgets/$sk_enc" || echo "000"
  )
  case "$cleanup_code" in
    2*) echo "auth-probe: cleanup DELETE for widget $created_sitekey succeeded (HTTP $cleanup_code)." >&2 ;;
    *)  echo "auth-probe: cleanup DELETE for widget $created_sitekey FAILED (HTTP $cleanup_code). Please remove it from the Turnstile dashboard manually." >&2 ;;
  esac
fi

case "$verdict" in
  scope_ok)
    emit "$(python3 -I -c '
import json, sys
account_id, accounts_raw = sys.argv[1], sys.argv[2]
try:
    accounts = json.loads(accounts_raw)
except Exception:
    accounts = []
print(json.dumps({"status":"ok","account_id":account_id,"accounts":accounts}))
' "$account_id" "$accounts_json")"
    ;;
  missing_scope)
    echo "auth-probe: token cannot write /challenges/widgets on account $account_id (HTTP $edit_code). Missing Account.Turnstile:Edit." >&2
    emit "$(python3 -I -c '
import json, sys
account_id, http_code = sys.argv[1], sys.argv[2]
try:
    code_num = int(http_code)
except ValueError:
    code_num = 0
print(json.dumps({"status":"missing_scope","account_id":account_id,"http_code":code_num}))
' "$account_id" "$edit_code")"
    ;;
  *)
    echo "auth-probe: unexpected response probing Edit scope on account $account_id (HTTP $edit_code)." >&2
    emit "$(python3 -I -c '
import json, sys
account_id, http_code = sys.argv[1], sys.argv[2]
try:
    code_num = int(http_code)
except ValueError:
    code_num = 0
print(json.dumps({"status":"upstream_failure","account_id":account_id,"http_code":code_num}))
' "$account_id" "$edit_code")"
    ;;
esac
