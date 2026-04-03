#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_DIR="$(dirname "$SCRIPT_DIR")"
SSL_DIR="$DOCKER_DIR/nginx/ssl"
LIVE_DIR="$SSL_DIR/live"
COMPOSE_FILE="$DOCKER_DIR/docker-compose.production.yml"

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Bootstrap SSL certificates for the Raava Dashboard nginx proxy.

Options:
  --self-signed              Generate a self-signed certificate (development)
  --letsencrypt              Obtain a Let's Encrypt certificate (production)
  --domain DOMAIN            Domain name for the certificate (required for --letsencrypt)
  --email EMAIL              Email for Let's Encrypt notifications (required for --letsencrypt)
  --staging                  Use Let's Encrypt staging environment (for testing)
  -h, --help                 Show this help message

Examples:
  $(basename "$0") --self-signed
  $(basename "$0") --letsencrypt --domain demo.raava.io --email admin@raava.io
  $(basename "$0") --letsencrypt --domain demo.raava.io --email admin@raava.io --staging
EOF
  exit "${1:-0}"
}

MODE=""
DOMAIN=""
EMAIL=""
STAGING=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --self-signed)
      MODE="self-signed"
      shift
      ;;
    --letsencrypt)
      MODE="letsencrypt"
      shift
      ;;
    --domain)
      DOMAIN="${2:-}"
      if [[ -z "$DOMAIN" ]]; then
        echo "Error: --domain requires a value"
        usage 1
      fi
      shift 2
      ;;
    --email)
      EMAIL="${2:-}"
      if [[ -z "$EMAIL" ]]; then
        echo "Error: --email requires a value"
        usage 1
      fi
      shift 2
      ;;
    --staging)
      STAGING="--staging"
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Error: Unknown option $1"
      usage 1
      ;;
  esac
done

if [[ -z "$MODE" ]]; then
  echo "Error: Must specify --self-signed or --letsencrypt"
  echo ""
  usage 1
fi

mkdir -p "$LIVE_DIR"

# generate_self_signed generates a self-signed X.509 certificate (CN=localhost) and an RSA 2048 private key valid for 365 days, writing fullchain.pem and privkey.pem into "$LIVE_DIR" and printing their locations and next steps.
generate_self_signed() {
  echo "Generating self-signed certificate..."
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout "$LIVE_DIR/privkey.pem" \
    -out "$LIVE_DIR/fullchain.pem" \
    -subj "/CN=localhost" \
    2>/dev/null

  echo "Self-signed certificate generated at:"
  echo "  $LIVE_DIR/fullchain.pem"
  echo "  $LIVE_DIR/privkey.pem"
  echo ""
  echo "You can now start the stack:"
  echo "  cd $DOCKER_DIR && docker compose -f docker-compose.production.yml up -d"
}

# obtain_letsencrypt obtains a Let's Encrypt certificate for the configured DOMAIN and installs the issued certificate and private key into the nginx SSL live directory.
# Requires global variables DOMAIN and EMAIL; exits with status 1 if either is missing, and reloads nginx after installing the certificate.
obtain_letsencrypt() {
  if [[ -z "$DOMAIN" ]]; then
    echo "Error: --domain is required for Let's Encrypt"
    exit 1
  fi
  if [[ -z "$EMAIL" ]]; then
    echo "Error: --email is required for Let's Encrypt"
    exit 1
  fi

  echo "Step 1: Generating temporary self-signed certificate..."
  openssl req -x509 -nodes -days 1 -newkey rsa:2048 \
    -keyout "$LIVE_DIR/privkey.pem" \
    -out "$LIVE_DIR/fullchain.pem" \
    -subj "/CN=$DOMAIN" \
    2>/dev/null

  echo "Step 2: Starting nginx with temporary certificate..."
  docker compose -f "$COMPOSE_FILE" up -d nginx

  echo "Step 3: Requesting Let's Encrypt certificate for $DOMAIN..."
  docker compose -f "$COMPOSE_FILE" run --rm certbot \
    certonly --webroot --webroot-path=/var/www/certbot \
    --email "$EMAIL" --agree-tos --no-eff-email \
    $STAGING \
    -d "$DOMAIN"

  echo "Step 4: Copying certificates to nginx ssl directory..."
  # The certbot container mounts ./nginx/ssl:/etc/letsencrypt,
  # so certs are available at $SSL_DIR/live/$DOMAIN/
  if [[ -f "$SSL_DIR/live/$DOMAIN/fullchain.pem" ]]; then
    cp -L "$SSL_DIR/live/$DOMAIN/fullchain.pem" "$LIVE_DIR/fullchain.pem"
    cp -L "$SSL_DIR/live/$DOMAIN/privkey.pem" "$LIVE_DIR/privkey.pem"
  else
    echo "Warning: Could not find certbot output at $SSL_DIR/live/$DOMAIN/"
    echo "You may need to manually copy the certificates."
  fi

  echo "Step 5: Reloading nginx..."
  docker compose -f "$COMPOSE_FILE" exec nginx nginx -s reload

  echo ""
  echo "Let's Encrypt certificate obtained for $DOMAIN"
  echo "The certbot service will handle automatic renewal."
}

case "$MODE" in
  self-signed)
    generate_self_signed
    ;;
  letsencrypt)
    obtain_letsencrypt
    ;;
esac
