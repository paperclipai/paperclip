#!/usr/bin/env bash
#
# Bootstrap a fresh Paperclip SSO dev instance running via docker-compose.sso.yml.
#
# Prerequisites:
#   docker compose -f docker/docker-compose.sso.yml up --build -d
#
# What it does (same as manual curl flow):
#   1. Waits for Paperclip API to become healthy
#   2. Creates an admin user via Better Auth sign-up
#   3. Creates a bootstrap CEO invite via the local CLI
#   4. Accepts the invite to promote the user to instance admin
#
# Usage:
#   ./scripts/bootstrap-sso-dev.sh
#   ADMIN_EMAIL=me@example.com ADMIN_PASSWORD=secret123 ./scripts/bootstrap-sso-dev.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

BASE_URL="${PAPERCLIP_PUBLIC_URL:-http://localhost:3100}"
DB_URL="${DATABASE_URL:-postgres://paperclip:paperclip@localhost:5432/paperclip}"
ADMIN_NAME="${ADMIN_NAME:-SSO Admin}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@paperclip.dev}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-paperclip-admin-123}"

COOKIE_JAR="$(mktemp "${TMPDIR:-/tmp}/paperclip-bootstrap.XXXXXX")"
TMP_RESPONSE="$(mktemp "${TMPDIR:-/tmp}/paperclip-response.XXXXXX")"
cleanup() { rm -f "$COOKIE_JAR" "$TMP_RESPONSE"; }
trap cleanup EXIT

health_url="$BASE_URL/api/health"

echo "==> Waiting for Paperclip at $health_url ..."
attempts=0
max_attempts=90
while ! curl -fsS "$health_url" >/dev/null 2>&1; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge "$max_attempts" ]; then
    echo "FATAL: Paperclip did not become ready after ${max_attempts}s" >&2
    exit 1
  fi
  sleep 1
done
echo "    Server is up."

health_json="$(curl -fsS "$health_url")"
if echo "$health_json" | grep -q '"bootstrapStatus":"ready"'; then
  echo "==> Instance already bootstrapped, nothing to do."
  echo "    Sign in at $BASE_URL with your admin credentials."
  exit 0
fi

echo "==> Creating admin user ($ADMIN_EMAIL) ..."
http_status="$(curl -sS -o "$TMP_RESPONSE" -w "%{http_code}" \
  -X POST "$BASE_URL/api/auth/sign-up/email" \
  -H "Content-Type: application/json" \
  -H "Origin: $BASE_URL" \
  -c "$COOKIE_JAR" \
  -d "{\"name\":\"$ADMIN_NAME\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")"

if [[ "$http_status" =~ ^2 ]]; then
  echo "    User created."
elif [[ "$http_status" == "422" ]] || [[ "$http_status" == "409" ]]; then
  echo "    User already exists, signing in ..."
  http_status="$(curl -sS -o "$TMP_RESPONSE" -w "%{http_code}" \
    -X POST "$BASE_URL/api/auth/sign-in/email" \
    -H "Content-Type: application/json" \
    -H "Origin: $BASE_URL" \
    -c "$COOKIE_JAR" \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")"
  if [[ ! "$http_status" =~ ^2 ]]; then
    echo "FATAL: sign-in failed (HTTP $http_status)" >&2
    cat "$TMP_RESPONSE" >&2
    exit 1
  fi
  echo "    Signed in."
else
  echo "FATAL: sign-up failed (HTTP $http_status)" >&2
  cat "$TMP_RESPONSE" >&2
  exit 1
fi

echo "==> Generating bootstrap CEO invite ..."
TMP_CONFIG="$(mktemp "${TMPDIR:-/tmp}/paperclip-cfg.XXXXXX.json")"
cat > "$TMP_CONFIG" <<CFGEOF
{
  "\$meta": { "version": 1, "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)", "source": "configure" },
  "database": { "mode": "postgres", "connectionString": "$DB_URL" },
  "logging": { "mode": "file" },
  "server": { "deploymentMode": "authenticated", "exposure": "private", "host": "0.0.0.0", "port": 3100 }
}
CFGEOF

bootstrap_output="$(cd "$REPO_ROOT" && DATABASE_URL="$DB_URL" \
  pnpm paperclipai auth bootstrap-ceo \
    -c "$TMP_CONFIG" \
    --base-url "$BASE_URL" 2>&1)"
rm -f "$TMP_CONFIG"

invite_url="$(echo "$bootstrap_output" | grep -o 'https\?://[^[:space:]]*/invite/pcp_bootstrap_[[:alnum:]]*' | tail -n 1)"
if [ -z "$invite_url" ]; then
  echo "FATAL: bootstrap-ceo did not produce an invite URL" >&2
  echo "$bootstrap_output" >&2
  exit 1
fi
invite_token="${invite_url##*/}"
echo "    Invite: $invite_url"

echo "==> Accepting bootstrap invite ..."
http_status="$(curl -sS -o "$TMP_RESPONSE" -w "%{http_code}" \
  -X POST "$BASE_URL/api/invites/$invite_token/accept" \
  -H "Content-Type: application/json" \
  -H "Origin: $BASE_URL" \
  -b "$COOKIE_JAR" \
  -c "$COOKIE_JAR" \
  -d '{"requestType":"human"}')"

if [[ ! "$http_status" =~ ^2 ]]; then
  echo "FATAL: invite acceptance failed (HTTP $http_status)" >&2
  cat "$TMP_RESPONSE" >&2
  exit 1
fi
echo "    Bootstrap accepted."

echo ""
echo "==> Done. Instance is ready."
echo ""
echo "    URL:      $BASE_URL"
echo "    Email:    $ADMIN_EMAIL"
echo "    Password: $ADMIN_PASSWORD"
echo ""
echo "    To enable SSO:"
echo "    1. Sign in, go to Instance Settings > SSO"
echo "    2. Toggle Enable SSO, add a Keycloak provider:"
echo "       Provider ID: keycloak"
echo "       Type: keycloak"
echo "       Client ID: paperclip"
echo "       Client Secret: paperclip-sso-secret"
echo "       Issuer: http://localhost:8080/realms/paperclip"
echo "       Display Name: Keycloak SSO"
echo "    3. Save. The SSO button appears on the login page immediately."
echo ""
echo "    Keycloak users: admin/admin (human role), operator/operator (human role), viewer/viewer (no role)"
echo "    Keycloak admin: http://localhost:8080/admin (admin/admin)"
