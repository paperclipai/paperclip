#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script with sudo or as root." >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"
COMPOSE_CADDY_FILE="${SCRIPT_DIR}/docker-compose.caddy.yml"
COMPOSE_NGINX_FILE="${SCRIPT_DIR}/docker-compose.nginx.yml"
EXAMPLE_ENV_FILE="${SCRIPT_DIR}/.env.example"
ENV_FILE="${SCRIPT_DIR}/.env"

if [[ ! -f "${COMPOSE_FILE}" ]]; then
  echo "Missing ${COMPOSE_FILE}. Run this from a Paperclip checkout." >&2
  exit 1
fi

if [[ ! -f "${EXAMPLE_ENV_FILE}" ]]; then
  echo "Missing ${EXAMPLE_ENV_FILE}." >&2
  exit 1
fi

. /etc/os-release
case "${ID:-}" in
  ubuntu|debian)
    ;;
  *)
    echo "This script currently supports Ubuntu or Debian VMs on Proxmox." >&2
    exit 1
    ;;
esac

requested_public_url="${PAPERCLIP_PUBLIC_URL:-}"
requested_port="${PAPERCLIP_PORT:-}"
requested_bind_host="${PAPERCLIP_BIND_HOST:-}"
requested_data_dir="${PAPERCLIP_DATA_DIR:-}"
requested_secret="${BETTER_AUTH_SECRET:-}"
requested_allowed_hostnames="${PAPERCLIP_ALLOWED_HOSTNAMES:-}"
requested_proxy_mode="${PAPERCLIP_PROXY_MODE:-}"
requested_server_name="${PAPERCLIP_SERVER_NAME:-}"
requested_caddy_data_dir="${CADDY_DATA_DIR:-}"
requested_caddy_config_dir="${CADDY_CONFIG_DIR:-}"
requested_nginx_cert_dir="${NGINX_CERT_DIR:-}"
requested_openai_key="${OPENAI_API_KEY:-}"
requested_anthropic_key="${ANTHROPIC_API_KEY:-}"
requested_mode="${PAPERCLIP_DEPLOYMENT_MODE:-}"
requested_exposure="${PAPERCLIP_DEPLOYMENT_EXPOSURE:-}"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
fi

PAPERCLIP_PORT="${requested_port:-${PAPERCLIP_PORT:-3100}}"
PAPERCLIP_BIND_HOST="${requested_bind_host:-${PAPERCLIP_BIND_HOST:-0.0.0.0}}"
PAPERCLIP_DATA_DIR="${requested_data_dir:-${PAPERCLIP_DATA_DIR:-/srv/paperclip}}"
PAPERCLIP_DEPLOYMENT_MODE="${requested_mode:-${PAPERCLIP_DEPLOYMENT_MODE:-authenticated}}"
PAPERCLIP_DEPLOYMENT_EXPOSURE="${requested_exposure:-${PAPERCLIP_DEPLOYMENT_EXPOSURE:-private}}"
PAPERCLIP_ALLOWED_HOSTNAMES="${requested_allowed_hostnames:-${PAPERCLIP_ALLOWED_HOSTNAMES:-}}"
PAPERCLIP_PROXY_MODE="${requested_proxy_mode:-${PAPERCLIP_PROXY_MODE:-none}}"
PAPERCLIP_SERVER_NAME="${requested_server_name:-${PAPERCLIP_SERVER_NAME:-}}"
CADDY_DATA_DIR="${requested_caddy_data_dir:-${CADDY_DATA_DIR:-/srv/caddy/data}}"
CADDY_CONFIG_DIR="${requested_caddy_config_dir:-${CADDY_CONFIG_DIR:-/srv/caddy/config}}"
NGINX_CERT_DIR="${requested_nginx_cert_dir:-${NGINX_CERT_DIR:-/srv/nginx/certs}}"
OPENAI_API_KEY="${requested_openai_key:-${OPENAI_API_KEY:-}}"
ANTHROPIC_API_KEY="${requested_anthropic_key:-${ANTHROPIC_API_KEY:-}}"

case "${PAPERCLIP_PROXY_MODE}" in
  none|caddy|nginx)
    ;;
  *)
    echo "Unsupported PAPERCLIP_PROXY_MODE=${PAPERCLIP_PROXY_MODE}. Use none, caddy, or nginx." >&2
    exit 1
    ;;
esac

if [[ "${PAPERCLIP_PROXY_MODE}" != "none" ]]; then
  if [[ -z "${requested_bind_host}" ]]; then
    PAPERCLIP_BIND_HOST="127.0.0.1"
  fi
  if [[ -z "${PAPERCLIP_SERVER_NAME}" ]]; then
    echo "PAPERCLIP_SERVER_NAME is required when PAPERCLIP_PROXY_MODE=${PAPERCLIP_PROXY_MODE}." >&2
    exit 1
  fi
fi

if [[ -n "${requested_public_url}" ]]; then
  PAPERCLIP_PUBLIC_URL="${requested_public_url}"
elif [[ -z "${PAPERCLIP_PUBLIC_URL:-}" ]]; then
  if [[ "${PAPERCLIP_PROXY_MODE}" == "none" ]]; then
    primary_ip="$(hostname -I | awk '{print $1}')"
    PAPERCLIP_PUBLIC_URL="http://${primary_ip}:${PAPERCLIP_PORT}"
  else
    PAPERCLIP_PUBLIC_URL="https://${PAPERCLIP_SERVER_NAME}"
  fi
fi

if [[ -n "${requested_secret}" ]]; then
  BETTER_AUTH_SECRET="${requested_secret}"
elif [[ -z "${BETTER_AUTH_SECRET:-}" || "${BETTER_AUTH_SECRET}" == "replace-me" ]]; then
  BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git gnupg openssl

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  arch="$(dpkg --print-architecture)"
  echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

install -d -m 0775 -o 1000 -g 1000 "${PAPERCLIP_DATA_DIR}"

compose_args=(-f "${COMPOSE_FILE}")

if [[ "${PAPERCLIP_PROXY_MODE}" == "caddy" ]]; then
  install -d -m 0755 "${CADDY_DATA_DIR}" "${CADDY_CONFIG_DIR}"
  compose_args+=(-f "${COMPOSE_CADDY_FILE}")
fi

if [[ "${PAPERCLIP_PROXY_MODE}" == "nginx" ]]; then
  install -d -m 0755 "${NGINX_CERT_DIR}"
  if [[ ! -f "${NGINX_CERT_DIR}/fullchain.pem" || ! -f "${NGINX_CERT_DIR}/privkey.pem" ]]; then
    echo "NGINX_CERT_DIR must contain fullchain.pem and privkey.pem before nginx mode can start." >&2
    exit 1
  fi
  compose_args+=(-f "${COMPOSE_NGINX_FILE}")
fi

cat > "${ENV_FILE}" <<EOF
PAPERCLIP_PUBLIC_URL=${PAPERCLIP_PUBLIC_URL}
PAPERCLIP_PORT=${PAPERCLIP_PORT}
PAPERCLIP_BIND_HOST=${PAPERCLIP_BIND_HOST}
PAPERCLIP_DATA_DIR=${PAPERCLIP_DATA_DIR}
BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}
PAPERCLIP_ALLOWED_HOSTNAMES=${PAPERCLIP_ALLOWED_HOSTNAMES}
PAPERCLIP_PROXY_MODE=${PAPERCLIP_PROXY_MODE}
PAPERCLIP_SERVER_NAME=${PAPERCLIP_SERVER_NAME}
CADDY_DATA_DIR=${CADDY_DATA_DIR}
CADDY_CONFIG_DIR=${CADDY_CONFIG_DIR}
NGINX_CERT_DIR=${NGINX_CERT_DIR}
OPENAI_API_KEY=${OPENAI_API_KEY}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
PAPERCLIP_DEPLOYMENT_MODE=${PAPERCLIP_DEPLOYMENT_MODE}
PAPERCLIP_DEPLOYMENT_EXPOSURE=${PAPERCLIP_DEPLOYMENT_EXPOSURE}
EOF

docker compose "${compose_args[@]}" --env-file "${ENV_FILE}" up -d --build

for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PAPERCLIP_PORT}/api/health" >/dev/null; then
    echo "Paperclip is running at ${PAPERCLIP_PUBLIC_URL}"
    echo "Data dir: ${PAPERCLIP_DATA_DIR}"
    exit 0
  fi
  sleep 5
done

docker compose "${compose_args[@]}" --env-file "${ENV_FILE}" ps >&2
docker compose "${compose_args[@]}" --env-file "${ENV_FILE}" logs --tail 120 >&2
echo "Paperclip did not become healthy within the expected time window." >&2
exit 1
