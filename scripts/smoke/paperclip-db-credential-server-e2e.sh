#!/bin/bash
# Boots the real Paperclip server with a disposable PostgreSQL and file credential.
set -Eeuo pipefail
set +x
trap 'printf "Paperclip server smoke failed at line %s\n" "$LINENO" >&2' ERR
repo_root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
scratch_parent=${PAPERCLIP_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}}
scratch=$(mktemp -d "$scratch_parent/paperclip-db-server-e2e.XXXXXX")
chmod 0755 "$scratch"
container="paperclip-db-e2e-$$"
network="paperclip-db-e2e-$$"
server_pid=
proxy_pid=
cleanup() {
  if [ -n "$proxy_pid" ]; then
    kill "$proxy_pid" >/dev/null 2>&1 || true
    wait "$proxy_pid" >/dev/null 2>&1 || true
  fi
  if [ -n "$server_pid" ]; then
    kill -TERM -- "-$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" >/dev/null 2>&1 || true
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT

password=$(openssl rand -hex 16)
cat > "$scratch/postgres.env" <<EOF
POSTGRES_USER=paperclip
POSTGRES_DB=paperclip
POSTGRES_PASSWORD=$password
EOF
chmod 0600 "$scratch/postgres.env"
docker run --rm -d --name "$container" -p 127.0.0.1::5432 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,size=512m \
  --env-file "$scratch/postgres.env" \
  postgres:16@sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54 >/dev/null
for ((attempt=1; attempt<=30; attempt++)); do
  if docker exec "$container" psql -U paperclip -d paperclip -X -qAt -c 'SELECT 1' 2>/dev/null | grep -qx 1; then break; fi
  sleep 1
done
if ! docker exec "$container" psql -U paperclip -d paperclip -X -qAt -c 'SELECT 1' 2>/dev/null | grep -qx 1; then
  docker inspect "$container" --format 'Postgres container state: {{.State.Status}}, exit={{.State.ExitCode}}' >&2 || true
  docker logs "$container" 2>&1 | sed -E -e "s/$password/[REDACTED]/g" -e 's#postgres(ql)?://[^[:space:]]+#postgres://[REDACTED]#g' | tail -12 >&2 || true
  exit 1
fi
db_port=$(docker port "$container" 5432/tcp | sed -n 's/.*://p' | head -1)
[ -n "$db_port" ]
server_port=$(python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    print(sock.getsockname()[1])
PY
)
mkdir -p "$scratch/home"
cat > "$scratch/config.json" <<EOF
{"\$meta":{"version":1,"updatedAt":"2026-09-27T00:00:00.000Z","source":"configure"},
 "database":{"mode":"postgres","backup":{"enabled":false}},
 "logging":{"mode":"file","logDir":"$scratch/home/logs"},
 "server":{"deploymentMode":"local_trusted","exposure":"private","host":"127.0.0.1","port":$server_port,"serveUi":false},
 "telemetry":{"enabled":false}}
EOF
printf 'postgres://paperclip:%s@127.0.0.1:%s/paperclip?application_name=credential_smoke\n' "$password" "$db_port" > "$scratch/database-url"
chmod 0600 "$scratch/database-url"
cp "$repo_root/scripts/smoke/paperclip-db-credential-agent-probe.py" "$scratch/agent-probe.py"
chmod 0644 "$scratch/agent-probe.py"
# Only this synthetic workspace is writable by the reduced-capability container.
mkdir -m 0777 "$scratch/workspace"
cp "$scratch/agent-probe.py" "$scratch/workspace/agent-probe.py"
docker build -q -f "$repo_root/ops/paperclip-db-credential/Dockerfile.e2e" \
  -t paperclip-db-credential-e2e:local "$repo_root/ops/paperclip-db-credential" >/dev/null
docker build -q -f "$repo_root/ops/paperclip-db-credential/Dockerfile.local-sandbox-e2e" \
  -t paperclip-db-credential-local-sandbox-e2e:local "$repo_root/ops/paperclip-db-credential" >/dev/null
docker network create --internal "$network" >/dev/null
[ "$(docker network inspect "$network" --format '{{.Internal}}')" = true ]
bridge_ip=$(docker network inspect "$network" --format '{{(index .IPAM.Config 0).Gateway}}')
setsid env -i PATH="$PATH" HOME="$scratch/home" \
  PAPERCLIP_HOME="$scratch/home" PAPERCLIP_CONFIG="$scratch/config.json" \
  PAPERCLIP_DATABASE_URL_FILE="$scratch/database-url" \
  PAPERCLIP_AGENT_JWT_SECRET=synthetic-jwt-signing-key-for-e2e-only \
  PAPERCLIP_ALLOWED_HOSTNAMES="$bridge_ip" \
  PAPERCLIP_MIGRATION_AUTO_APPLY=true PAPERCLIP_MIGRATION_PROMPT=never \
  "$repo_root/server/node_modules/.bin/tsx" "$repo_root/server/src/index.ts" \
  > "$scratch/server.log" 2>&1 &
server_pid=$!
code=000
for ((attempt=1; attempt<=120; attempt++)); do
  code=$(curl -sS --max-time 1 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$server_port/api/health" 2>/dev/null || true)
  if [ "$code" = 200 ]; then break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then break; fi
  sleep 1
done
if [ "$code" != 200 ]; then
  echo "Paperclip health smoke failed: HTTP $code" >&2
  sed -E -e "s/$password/[REDACTED]/g" -e 's#postgres(ql)?://[^[:space:]]+#postgres://[REDACTED]#g' "$scratch/server.log" | tail -15 >&2
  exit 1
fi
if grep -F "$password" "$scratch/server.log" >/dev/null; then
  echo "Paperclip log contains the synthetic DB password" >&2
  exit 1
fi
python3 "$repo_root/scripts/smoke/paperclip-db-credential-api-proxy.py" \
  "$bridge_ip" "$server_port" "$scratch/proxy-port" &
proxy_pid=$!
for ((attempt=1; attempt<=30; attempt++)); do
  if [ -s "$scratch/proxy-port" ]; then break; fi
  if ! kill -0 "$proxy_pid" 2>/dev/null; then break; fi
  sleep 1
done
[ -s "$scratch/proxy-port" ]
proxy_port=$(cat "$scratch/proxy-port")
agent_api_url="http://$bridge_ip:$proxy_port"
proxy_health=$(curl --noproxy '*' -sS --max-time 2 -o /dev/null -w '%{http_code}' "$agent_api_url/api/health")
if [ "$proxy_health" != 200 ]; then
  echo "Docker bridge API proxy health failed: HTTP $proxy_health" >&2
  exit 1
fi
env -i PATH="$PATH" HOME="$scratch/home" \
  PAPERCLIP_HOME="$scratch/home" PAPERCLIP_CONFIG="$scratch/config.json" \
  PAPERCLIP_DATABASE_URL_FILE="$scratch/database-url" \
  PAPERCLIP_AGENT_JWT_SECRET=synthetic-jwt-signing-key-for-e2e-only \
  PAPERCLIP_E2E_DOCKER_NETWORK="$network" \
  "$repo_root/server/node_modules/.bin/tsx" \
  "$repo_root/server/scripts/paperclip-db-credential-jwt-probe.ts" \
  "$agent_api_url" "$scratch" "$repo_root"
echo "Paperclip file-backed DB smoke passed: /api/health HTTP $code, pg_dump/psql restore 2 checks, log credential leak 0, Docker UID and remote sandbox 6 checks, local bwrap 6 denials + substituted launcher denial + PATH/loader denial + JWT API pass + CODEX_HOME leaf and directory alias staging denials + bound auth/skills pass + alias race denial"
