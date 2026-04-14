#!/usr/bin/env bash
# backup-docker.sh — Backup do banco de dados em ambiente Docker prod
#
# Uso:
#   ./scripts/backup-docker.sh
#   ./scripts/backup-docker.sh --output /caminho/do/backup.sql.gz
#
# Restauração:
#   gunzip -c backup.sql.gz | docker exec -i <container_db> psql -U paperclip -d paperclip
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/docker/docker-compose.prod.yml"

# Parse flags
OUTPUT_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output|-o) OUTPUT_FILE="$2"; shift 2 ;;
    *) echo "Uso: $0 [--output arquivo.sql.gz]" >&2; exit 1 ;;
  esac
done

# Default: backups/<timestamp>.sql.gz
BACKUP_DIR="$PROJECT_ROOT/backups"
mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
OUTPUT_FILE="${OUTPUT_FILE:-$BACKUP_DIR/backup_${TIMESTAMP}.sql.gz}"

# Discover running db container
DB_CONTAINER=$(docker compose -f "$COMPOSE_FILE" ps -q db 2>/dev/null | head -1)
if [[ -z "$DB_CONTAINER" ]]; then
  echo "Erro: container do banco não encontrado. Verifique se o stack está rodando." >&2
  exit 1
fi

echo "→ Realizando backup do banco..."
TMP_BACKUP=$(mktemp "${BACKUP_DIR}/.backup_tmp_XXXXXXXX.sql.gz")
docker exec "$DB_CONTAINER" \
  pg_dump -U paperclip -d paperclip --no-owner --no-acl \
  | gzip > "$TMP_BACKUP"

if [[ ! -s "$TMP_BACKUP" ]]; then
  rm -f "$TMP_BACKUP"
  echo "Erro: backup vazio ou falha no pg_dump." >&2
  exit 1
fi

if ! gzip -t "$TMP_BACKUP" 2>/dev/null; then
  rm -f "$TMP_BACKUP"
  echo "Erro: backup corrompido (falha na verificação de integridade gzip)." >&2
  exit 1
fi

mv "$TMP_BACKUP" "$OUTPUT_FILE"

SIZE=$(du -sh "$OUTPUT_FILE" | cut -f1)
echo "✔ Backup salvo em: $OUTPUT_FILE ($SIZE)"
echo ""
echo "Para restaurar:"
echo "  gunzip -c \"$OUTPUT_FILE\" | docker compose -f \"$COMPOSE_FILE\" exec -T db psql -U paperclip -d paperclip"
