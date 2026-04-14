#!/usr/bin/env bash
# setup.sh — Instalador interativo da Toca da IA
# Uso: ./setup.sh
set -euo pipefail

BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RED="\033[0;31m"
RESET="\033[0m"

info()    { echo -e "${GREEN}✔${RESET} $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET}  $*"; }
error()   { echo -e "${RED}✘${RESET} $*" >&2; }
heading() { echo -e "\n${BOLD}$*${RESET}"; }

# ─── Verificações de dependências ────────────────────────────────────────────

heading "Verificando dependências..."
MISSING=()
command -v docker  >/dev/null 2>&1 || MISSING+=("docker")
command -v curl    >/dev/null 2>&1 || MISSING+=("curl")
command -v openssl >/dev/null 2>&1 || MISSING+=("openssl")

if [[ ${#MISSING[@]} -gt 0 ]]; then
  error "Dependências ausentes: ${MISSING[*]}"
  echo "Instale-as antes de continuar."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  error "Docker não está rodando. Inicie o Docker e tente novamente."
  exit 1
fi
info "Docker disponível"

# ─── Coleta de configuração ──────────────────────────────────────────────────

heading "Configuração da instância"

if [[ -f .env ]]; then
  warn ".env já existe. Pressione Enter para mantê-lo ou 's' para recriar."
  read -r RECREATE
  if [[ "$RECREATE" != "s" && "$RECREATE" != "S" ]]; then
    info "Usando .env existente."
    ENV_READY=true
    # Read PUBLIC_URL from existing .env so health check uses the correct URL
    PUBLIC_URL=$(grep -E '^PAPERCLIP_PUBLIC_URL=' .env | cut -d= -f2- | tr -d '"' || true)
  fi
fi

if [[ "${ENV_READY:-false}" != "true" ]]; then
  echo ""
  read -rp "URL pública da instância (ex: https://tocadaia.exemplo.com.br): " PUBLIC_URL
  if [[ -z "$PUBLIC_URL" ]]; then
    warn "URL não informada — usando http://localhost:3100"
    PUBLIC_URL="http://localhost:3100"
  elif [[ ! "$PUBLIC_URL" =~ ^https?://[^[:space:]]+$ ]]; then
    error "URL inválida (deve começar com http:// ou https://): $PUBLIC_URL"
    exit 1
  fi

  AUTH_SECRET=$(openssl rand -hex 32)
  DB_PASSWORD=$(openssl rand -hex 16)
  info "Segredos gerados automaticamente."

  echo ""
  echo "Chaves de API de IA (ao menos uma é necessária para os agentes funcionarem):"
  read -rsp "  ANTHROPIC_API_KEY (Enter para pular): " ANTHROPIC_KEY; echo
  read -rsp "  OPENAI_API_KEY    (Enter para pular): " OPENAI_KEY; echo

  if [[ -z "$ANTHROPIC_KEY" && -z "$OPENAI_KEY" ]]; then
    warn "Nenhuma chave de IA informada. Agentes não funcionarão sem ao menos uma."
  fi

  printf 'PAPERCLIP_PUBLIC_URL=%s\nBETTER_AUTH_SECRET=%s\nDB_PASSWORD=%s\nANTHROPIC_API_KEY=%s\nOPENAI_API_KEY=%s\nPAPERCLIP_DEPLOYMENT_MODE=authenticated\nPAPERCLIP_DEPLOYMENT_EXPOSURE=private\n' \
    "$PUBLIC_URL" "$AUTH_SECRET" "$DB_PASSWORD" "${ANTHROPIC_KEY:-}" "${OPENAI_KEY:-}" > .env
  chmod 600 .env
  info ".env criado com sucesso."
fi

# ─── Subir serviços ──────────────────────────────────────────────────────────

heading "Iniciando serviços..."
docker compose -f docker/docker-compose.prod.yml --env-file .env pull
docker compose -f docker/docker-compose.prod.yml --env-file .env up -d

# ─── Aguardar app ficar saudável ─────────────────────────────────────────────

heading "Aguardando a aplicação ficar pronta..."
APP_URL="${PUBLIC_URL:-http://localhost:3100}"
# Always poll locally via nginx (avoids DNS/TLS dependency during first-time setup)
HTTP_PORT_LOCAL="${HTTP_PORT:-80}"
HEALTH_URL="http://localhost:${HTTP_PORT_LOCAL}/health"

RETRIES=30
for i in $(seq 1 $RETRIES); do
  HEALTH_RESPONSE=$(curl -sf "$HEALTH_URL" 2>/dev/null || true)
  if echo "$HEALTH_RESPONSE" | grep -q '"status":"ok"'; then
    info "Aplicação pronta!"
    break
  fi
  if [[ $i -eq $RETRIES ]]; then
    error "Timeout aguardando a aplicação. Verifique os logs:"
    echo "  docker compose -f docker/docker-compose.prod.yml logs app"
    echo "  docker compose -f docker/docker-compose.prod.yml logs nginx"
    exit 1
  fi
  echo -n "."
  sleep 3
done

# ─── Resumo ──────────────────────────────────────────────────────────────────

heading "Instalação concluída!"
echo ""
echo -e "  ${BOLD}URL:${RESET}    ${APP_URL}"
echo -e "  ${BOLD}Health:${RESET} ${APP_URL%/}/health"
echo ""
echo "Para verificar os logs:"
echo "  docker compose -f docker/docker-compose.prod.yml logs -f"
echo ""
echo "Para parar:"
echo "  docker compose -f docker/docker-compose.prod.yml down"
echo ""
echo "Para backup do banco:"
echo "  ./scripts/backup-docker.sh"
echo ""
