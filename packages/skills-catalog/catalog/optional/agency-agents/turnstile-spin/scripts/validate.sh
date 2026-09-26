#!/usr/bin/env bash
# Validates a Turnstile widget without placing its secret in arguments,
# exported environment variables, logs, or temporary files.

set +x
set -euo pipefail

usage() {
  echo "Usage: printf '%s' \"\$TURNSTILE_SECRET\" | $0 --sitekey <sitekey> --account-id <account-id> --expected-domains '<json-array>'" >&2
  exit 2
}

need_arg() {
  if [[ -z "${2-}" || "$2" == --* ]]; then
    usage
  fi
}

SITEKEY=""
ACCOUNT_ID=""
EXPECTED_DOMAINS_JSON=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sitekey)
      need_arg "$1" "${2-}"
      SITEKEY="$2"
      shift 2
      ;;
    --account-id)
      need_arg "$1" "${2-}"
      ACCOUNT_ID="$2"
      shift 2
      ;;
    --expected-domains)
      need_arg "$1" "${2-}"
      EXPECTED_DOMAINS_JSON="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

[[ -n "$SITEKEY" && -n "$ACCOUNT_ID" && -n "$EXPECTED_DOMAINS_JSON" ]] || usage
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN must be set}"
API_TOKEN="$CLOUDFLARE_API_TOKEN"
unset CLOUDFLARE_API_TOKEN
[[ "$API_TOKEN" =~ ^[A-Za-z0-9_-]+$ ]] || {
  echo "validate: CLOUDFLARE_API_TOKEN has an invalid format" >&2
  exit 1
}

for command_name in curl jq python3; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "validate: $command_name is required" >&2
    exit 1
  }
done

if ! jq -e '
  type == "array" and
  length > 0 and
  all(.[]; type == "string" and length > 0)
' <<<"$EXPECTED_DOMAINS_JSON" >/dev/null; then
  echo "validate: --expected-domains must be a non-empty JSON array of domains" >&2
  exit 2
fi

WIDGET_SECRET=""
IFS= read -r -d '' WIDGET_SECRET || true
trap 'unset API_TOKEN WIDGET_SECRET WIDGET_API_SECRET WIDGET_RESPONSE SITEVERIFY_RESPONSE' EXIT

if [[ -z "$WIDGET_SECRET" || "$WIDGET_SECRET" =~ [[:space:]] ]]; then
  echo "validate: standard input must contain one non-empty secret without whitespace" >&2
  exit 1
fi

ACCOUNT_ENCODED="$(python3 -I -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$ACCOUNT_ID")"
SITEKEY_ENCODED="$(python3 -I -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$SITEKEY")"

if ! WIDGET_RESPONSE="$(
  printf 'header = "Authorization: Bearer %s"\n' "$API_TOKEN" |
    curl --disable --config - --fail --silent --show-error \
      "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ENCODED/challenges/widgets/$SITEKEY_ENCODED"
)"; then
  echo "validate: widget metadata lookup failed" >&2
  exit 1
fi

if ! printf '%s' "$WIDGET_RESPONSE" | jq -e --arg sitekey "$SITEKEY" --argjson expected "$EXPECTED_DOMAINS_JSON" '
  . as $widget
  | (.success == true) and
    (.result.sitekey == $sitekey) and
    ((.result.clearance_level | type) == "string") and
    (.result.clearance_level as $clearance | ["no_clearance", "interactive", "managed", "jschallenge"] | index($clearance) != null) and
    ((.result.domains | type) == "array") and
    (all($expected[]; . as $domain | $widget.result.domains | index($domain) != null))
' >/dev/null; then
  echo "validate: widget sitekey, domains, or clearance level was invalid" >&2
  exit 1
fi

if ! WIDGET_API_SECRET="$(printf '%s' "$WIDGET_RESPONSE" | jq -er '.result.secret | select(type == "string" and test("^\\S+$"))')"; then
  echo "validate: widget metadata did not include a valid secret" >&2
  exit 1
fi
if [[ "$WIDGET_API_SECRET" != "$WIDGET_SECRET" ]]; then
  echo "validate: secret does not belong to the requested sitekey" >&2
  exit 1
fi
unset WIDGET_API_SECRET
unset WIDGET_RESPONSE

if ! SITEVERIFY_RESPONSE="$(
  printf '%s' "$WIDGET_SECRET" |
    python3 -I -c 'import sys,urllib.parse; print(urllib.parse.urlencode({"secret":sys.stdin.read(),"response":"XXXX.DUMMY.TOKEN.XXXX"}),end="")' |
    curl --disable --fail --silent --show-error \
      "https://challenges.cloudflare.com/turnstile/v0/siteverify" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      --data-binary @-
)"; then
  echo "validate: dummy-token siteverify request failed" >&2
  exit 1
fi

if ! jq -e '
  (.success == false) and
  ((.["error-codes"] | type) == "array") and
  ((.["error-codes"] | index("invalid-input-response")) != null) and
  ((.["error-codes"] | index("invalid-input-secret")) == null)
' <<<"$SITEVERIFY_RESPONSE" >/dev/null; then
  echo "validate: siteverify did not confirm the widget secret" >&2
  exit 1
fi

unset WIDGET_SECRET SITEVERIFY_RESPONSE
echo '{"status":"ok","metadata_check":"ran","dummy_siteverify":"ran"}'
