#!/bin/bash
# Instala o opencode.json no volume do paperclip.
#
# Rode UMA VEZ na VPS (como root) após o primeiro deploy do paperclip.
# O arquivo persiste no bind mount /opt/paperclip e sobrevive a rebuilds.
#
# Uso:
#   sudo bash deploy/dockploy/scripts/install-opencode-config.sh
#
# Por que não usar `configs:` do compose: o Docker monta configs como
# root:root sem leitura pra "other". O paperclip server roda como node
# (UID 1000) e falha com EACCES ao copiar o config para o tmp dir antes
# de cada run. Gravar direto no volume com o owner correto resolve.

set -euo pipefail

CONFIG_DIR="/opt/paperclip/.config/opencode"
CONFIG_FILE="$CONFIG_DIR/opencode.json"
SOURCE_FILE="$(dirname "$0")/../opencode.json"

if [[ ! -f "$SOURCE_FILE" ]]; then
  echo "ERRO: $SOURCE_FILE não existe. Você está rodando este script da raiz do repo?" >&2
  exit 1
fi

mkdir -p "$CONFIG_DIR"
cp "$SOURCE_FILE" "$CONFIG_FILE"
chown -R 1000:1000 /opt/paperclip/.config
chmod 0644 "$CONFIG_FILE"

echo "OK — opencode.json instalado em $CONFIG_FILE (owner 1000:1000)"
echo
echo "Conteúdo:"
cat "$CONFIG_FILE"
