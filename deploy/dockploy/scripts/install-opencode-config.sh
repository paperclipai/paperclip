#!/bin/bash
# Instala o opencode.json no volume do paperclip.
#
# Rode UMA VEZ na VPS após o primeiro deploy do paperclip — e novamente
# sempre que o opencode.json no repo for atualizado.
#
# Uso (curl one-liner, recomendado):
#   curl -fsSL https://raw.githubusercontent.com/victorbvieira/paperclip/prod/deploy/dockploy/scripts/install-opencode-config.sh | sudo bash
#
# Por que não usar `configs:` do compose: o Docker monta configs como
# root:root sem leitura pra "other". O paperclip server roda como node
# (UID 1000) e falha com EACCES ao copiar o config para o tmp dir antes
# de cada run. Gravar direto no volume com o owner correto resolve.

set -euo pipefail

CONFIG_DIR="/opt/paperclip/.config/opencode"
CONFIG_FILE="$CONFIG_DIR/opencode.json"
REPO_RAW_URL="${REPO_RAW_URL:-https://raw.githubusercontent.com/victorbvieira/paperclip/prod/deploy/dockploy/opencode.json}"

mkdir -p "$CONFIG_DIR"

# Baixa direto do GitHub raw — fonte de verdade é deploy/dockploy/opencode.json
curl -fsSL "$REPO_RAW_URL" -o "$CONFIG_FILE"

chown -R 1000:1000 /opt/paperclip/.config
chmod 0644 "$CONFIG_FILE"

echo "OK — opencode.json instalado em $CONFIG_FILE (owner 1000:1000, 0644)"
echo
echo "Conteúdo:"
cat "$CONFIG_FILE"
