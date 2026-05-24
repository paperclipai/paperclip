#!/usr/bin/env bash
# Paperclip Turkish fork — VPS bootstrap
# Usage (on a fresh Ubuntu 24.04 VPS as root):
#   curl -fsSL https://raw.githubusercontent.com/aliblackeye/paperclip-extra/i18n-tr-support/scripts/vps-setup.sh | DOMAIN=paperclip.karagozali.com bash
set -euo pipefail

DOMAIN="${DOMAIN:-paperclip.karagozali.com}"
BRANCH="${BRANCH:-i18n-tr-support}"
REPO_URL="${REPO_URL:-https://github.com/aliblackeye/paperclip-extra.git}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Bu script root olarak çalıştırılmalı (sudo bash)." >&2
  exit 1
fi

echo "============================================"
echo ">>> Paperclip VPS Setup"
echo ">>> Domain: ${DOMAIN}"
echo ">>> Branch: ${BRANCH}"
echo "============================================"

# ============ 1. Sistem güncelleme ============
echo ""
echo ">>> [1/10] Sistem güncelleniyor..."
export DEBIAN_FRONTEND=noninteractive
apt update -y
apt upgrade -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold"
apt install -y curl wget git ufw htop nano sudo ca-certificates gnupg openssl

# ============ 2. Swap (4GB) ============
echo ""
echo ">>> [2/10] Swap kontrol/oluşturma..."
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "Swap 4GB eklendi."
else
  echo "Swap zaten var, atlandı."
fi

# ============ 3. Firewall ============
echo ""
echo ">>> [3/10] UFW firewall kuruluyor..."
ufw --force reset >/dev/null 2>&1 || true
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP'
ufw allow 443/tcp comment 'HTTPS'
ufw --force enable

# ============ 4. Docker + Compose ============
echo ""
echo ">>> [4/10] Docker kuruluyor..."
if ! command -v docker &>/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  ARCH=$(dpkg --print-architecture)
  CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
  echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt update -y
  apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
else
  echo "Docker zaten kurulu."
fi

# ============ 5. paperclip user ============
echo ""
echo ">>> [5/10] paperclip user oluşturuluyor..."
if ! id paperclip &>/dev/null; then
  useradd -m -s /bin/bash paperclip
fi
usermod -aG docker paperclip
mkdir -p /home/paperclip/.ssh
if [ -f /root/.ssh/authorized_keys ]; then
  cp /root/.ssh/authorized_keys /home/paperclip/.ssh/
fi
chown -R paperclip:paperclip /home/paperclip/.ssh
chmod 700 /home/paperclip/.ssh
chmod 600 /home/paperclip/.ssh/authorized_keys 2>/dev/null || true

# ============ 6. Clone fork ============
echo ""
echo ">>> [6/10] Fork clone ediliyor..."
mkdir -p /opt/paperclip
chown paperclip:paperclip /opt/paperclip
if [ ! -d /opt/paperclip/repo/.git ]; then
  sudo -u paperclip git clone "${REPO_URL}" /opt/paperclip/repo
fi
cd /opt/paperclip/repo
sudo -u paperclip git fetch origin "${BRANCH}"
sudo -u paperclip git checkout "${BRANCH}"
sudo -u paperclip git pull origin "${BRANCH}"

# ============ 7. Secrets ============
echo ""
echo ">>> [7/10] Secret oluşturuluyor..."
SECRET_FILE=/opt/paperclip/.env
if [ ! -f "${SECRET_FILE}" ]; then
  BETTER_AUTH_SECRET=$(openssl rand -hex 32)
  cat > "${SECRET_FILE}" <<ENVEOF
DOMAIN=${DOMAIN}
BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}
ENVEOF
  chmod 600 "${SECRET_FILE}"
  echo "Yeni secret oluşturuldu."
else
  echo "Secret zaten var, korundu."
  # shellcheck disable=SC1090
  source "${SECRET_FILE}"
fi
# shellcheck disable=SC1090
source "${SECRET_FILE}"

# ============ 8. docker-compose.yml ============
echo ""
echo ">>> [8/10] docker-compose.yml yazılıyor..."
cat > /opt/paperclip/docker-compose.yml <<'COMPOSEEOF'
services:
  paperclip:
    build:
      context: /opt/paperclip/repo
      dockerfile: Dockerfile
    container_name: paperclip
    restart: unless-stopped
    expose:
      - "3100"
    environment:
      HOST: 0.0.0.0
      PORT: 3100
      PAPERCLIP_HOME: /paperclip
      PAPERCLIP_DEPLOYMENT_MODE: authenticated
      PAPERCLIP_DEPLOYMENT_EXPOSURE: public
      PAPERCLIP_PUBLIC_URL: https://${DOMAIN}
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET}
    volumes:
      - /opt/paperclip/data:/paperclip
      - /opt/paperclip/claude-config:/home/node/.claude
    networks:
      - paperclip-net

  caddy:
    image: caddy:2-alpine
    container_name: paperclip-caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /opt/paperclip/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on:
      - paperclip
    networks:
      - paperclip-net

networks:
  paperclip-net:
    driver: bridge

volumes:
  caddy-data:
  caddy-config:
COMPOSEEOF

# ============ 9. Caddyfile ============
echo ""
echo ">>> [9/10] Caddyfile yazılıyor..."
cat > /opt/paperclip/Caddyfile <<CADDYEOF
${DOMAIN} {
    encode gzip zstd
    reverse_proxy paperclip:3100
}
CADDYEOF

# ============ 10. Permissions ============
echo ""
echo ">>> [10/10] Dosya izinleri ayarlanıyor..."
mkdir -p /opt/paperclip/data /opt/paperclip/claude-config
chown -R paperclip:paperclip /opt/paperclip
chmod 600 /opt/paperclip/.env

echo ""
echo "============================================"
echo ">>> KURULUM TAMAM"
echo "============================================"
echo "Domain          : ${DOMAIN}"
echo "VPS Public IP   : $(curl -s ifconfig.me || echo 'unknown')"
echo "Compose dosyası : /opt/paperclip/docker-compose.yml"
echo "Env (gizli)     : /opt/paperclip/.env"
echo "Repo dizini     : /opt/paperclip/repo (branch: ${BRANCH})"
echo "Data dizini     : /opt/paperclip/data"
echo "============================================"
echo ""
echo "Sıradaki adım:"
echo "  cd /opt/paperclip && docker compose --env-file .env up -d --build"
echo ""
echo "Build ilk seferde 5-15 dakika sürer."
echo "Build sonrası: docker compose logs -f paperclip"
