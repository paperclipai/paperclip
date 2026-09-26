#!/usr/bin/env bash
# Creates a Turnstile widget without writing credentials or the response to disk.

set +x
set -uo pipefail

need_arg() {
  if [[ -z "${2-}" || "$2" == --* ]]; then
    echo "widget-create: missing value for $1" >&2
    exit 2
  fi
}

MODE="managed"
ACCOUNT_ID=""
NAME=""
DOMAINS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --account-id) need_arg "$1" "${2-}"; ACCOUNT_ID="$2"; shift 2 ;;
    --name) need_arg "$1" "${2-}"; NAME="$2"; shift 2 ;;
    --domains) need_arg "$1" "${2-}"; DOMAINS="$2"; shift 2 ;;
    --mode) need_arg "$1" "${2-}"; MODE="$2"; shift 2 ;;
    *) echo "widget-create: unknown arg $1" >&2; exit 2 ;;
  esac
done

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN must be set}"
API_TOKEN="$CLOUDFLARE_API_TOKEN"
unset CLOUDFLARE_API_TOKEN
[[ -n "$ACCOUNT_ID" ]] || { echo "widget-create: --account-id required" >&2; exit 2; }
[[ -n "$NAME" ]] || { echo "widget-create: --name required" >&2; exit 2; }
[[ -n "$DOMAINS" ]] || { echo "widget-create: --domains required" >&2; exit 2; }
[[ "$API_TOKEN" =~ ^[A-Za-z0-9_-]+$ ]] || {
  echo "widget-create: CLOUDFLARE_API_TOKEN has an invalid format" >&2
  exit 1
}
case "$MODE" in
  managed|invisible|non-interactive) ;;
  *) echo "widget-create: unsupported mode" >&2; exit 2 ;;
esac

for command_name in curl python3; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "widget-create: $command_name is required" >&2
    exit 1
  }
done

BODY_JSON="$(python3 -I -c '
import json, sys
name, domains_csv, mode = sys.argv[1], sys.argv[2], sys.argv[3]
domains = [domain.strip() for domain in domains_csv.split(",") if domain.strip()]
if not domains:
    raise SystemExit(2)
print(json.dumps({"name": name, "domains": domains, "mode": mode}))
' "$NAME" "$DOMAINS" "$MODE")" || {
  echo "widget-create: --domains must include at least one domain" >&2
  exit 2
}
ACCOUNT_ENCODED="$(python3 -I -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$ACCOUNT_ID")"

if ! API_RESPONSE="$(
  printf 'header = "Authorization: Bearer %s"\n' "$API_TOKEN" |
    curl --disable --config - --silent --show-error --write-out $'\n%{http_code}' -X POST \
      "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ENCODED/challenges/widgets" \
      -H "Content-Type: application/json" \
      --data "$BODY_JSON"
)"; then
  echo "widget-create: Cloudflare API request failed" >&2
  echo '{"status":"error","code":0,"message":"Cloudflare API request failed"}'
  exit 1
fi
unset BODY_JSON
unset API_TOKEN

HTTP_CODE="${API_RESPONSE##*$'\n'}"
RESPONSE_BODY="${API_RESPONSE%$'\n'*}"
unset API_RESPONSE

if ! printf '%s' "$RESPONSE_BODY" | python3 -I -c '
import json
import re
import sys

http_code = sys.argv[1]
try:
    data = json.load(sys.stdin)
except Exception:
    print(f"widget-create: non-JSON response (HTTP {http_code})", file=sys.stderr)
    print(json.dumps({"status":"error","code":0,"message":"Cloudflare API returned an invalid response"}))
    raise SystemExit(1)

errors = data.get("errors") if isinstance(data, dict) else []
first = errors[0] if isinstance(errors, list) and errors and isinstance(errors[0], dict) else {}
code = first.get("code", 0)
if not isinstance(data, dict) or data.get("success") is not True:
    print(f"widget-create: request failed (HTTP {http_code}, code={code})", file=sys.stderr)
    print(json.dumps({"status":"error","code":code,"message":"Cloudflare API request failed"}))
    raise SystemExit(1)

result = data.get("result")
sitekey = result.get("sitekey") if isinstance(result, dict) else None
secret = result.get("secret") if isinstance(result, dict) else None
if not (
    isinstance(sitekey, str)
    and re.fullmatch(r"\S{1,256}", sitekey)
    and isinstance(secret, str)
    and re.fullmatch(r"\S{1,1024}", secret)
):
    print("widget-create: API returned invalid widget credentials", file=sys.stderr)
    print(json.dumps({"status":"error","code":0,"message":"Cloudflare API returned invalid widget credentials"}))
    raise SystemExit(1)

print(json.dumps({"status":"ok","sitekey":sitekey,"secret":secret}))
' "$HTTP_CODE"; then
  unset RESPONSE_BODY
  exit 1
fi
unset RESPONSE_BODY
