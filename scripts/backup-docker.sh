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
umask 077  # ensure temp files are not world-readable

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/docker/docker-compose.prod.yml"

# Parse flags
OUTPUT_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output|-o) OUTPUT_FILE="$2"; mkdir -p "$(dirname "$OUTPUT_FILE")"; shift 2 ;;
    *) echo "Uso: $0 [--output arquivo.sql.gz]" >&2; exit 1 ;;
  esac
done

# Default: backups/<timestamp>.sql.gz
BACKUP_DIR="$PROJECT_ROOT/backups"
mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
OUTPUT_FILE="${OUTPUT_FILE:-$BACKUP_DIR/backup_${TIMESTAMP}.sql.gz}"

# Discover running db container
DB_CONTAINER=$(docker compose -f "$COMPOSE_FILE" ps -q db 2>/dev/null | head -1)
if [[ -z "$DB_CONTAINER" ]]; then
  echo "Erro: container do banco não encontrado. Verifique se o stack está rodando." >&2
  exit 1
fi
if [[ "$(docker inspect --format='{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null)" != "true" ]]; then
  echo "Erro: container do banco encontrado mas não está em execução." >&2
  exit 1
fi

echo "→ Realizando backup do banco..."
# Create temp file in the same directory as OUTPUT_FILE so mv is always same-device.
TMP_BACKUP=$(mktemp "$(dirname "$OUTPUT_FILE")/.backup_tmp_XXXXXXXX.sql.gz")
trap 'rm -f "$TMP_BACKUP"' EXIT INT TERM

docker exec "$DB_CONTAINER" \
  pg_dump -U paperclip -d paperclip --no-owner --no-acl \
  | gzip > "$TMP_BACKUP"
# Capture both exit codes before any subsequent command resets PIPESTATUS
_PIPE_STATUS=("${PIPESTATUS[@]}")
PGDUMP_EXIT=${_PIPE_STATUS[0]}
GZIP_EXIT=${_PIPE_STATUS[1]}

if [[ $PGDUMP_EXIT -ne 0 ]]; then
  echo "Erro: pg_dump falhou (exit $PGDUMP_EXIT)." >&2
  exit 1
fi

if [[ $GZIP_EXIT -ne 0 ]]; then
  echo "Erro: gzip falhou (exit $GZIP_EXIT) — backup pode estar incompleto." >&2
  exit 1
fi

if [[ ! -s "$TMP_BACKUP" ]]; then
  echo "Erro: backup vazio ou falha no pg_dump." >&2
  exit 1
fi

if ! gzip -t "$TMP_BACKUP" 2>/dev/null; then
  rm -f "$TMP_BACKUP"
  echo "Erro: backup corrompido (falha na verificação de integridade gzip)." >&2
  exit 1
fi

chmod 600 "$TMP_BACKUP"
mv "$TMP_BACKUP" "$OUTPUT_FILE"
trap - EXIT INT TERM

SIZE=$(du -sh "$OUTPUT_FILE" | cut -f1)
echo "✔ Backup salvo em: $OUTPUT_FILE ($SIZE)"
echo ""
echo "Para restaurar:"
echo "  gunzip -c \"$OUTPUT_FILE\" | docker compose -f \"$COMPOSE_FILE\" exec -T db psql -U paperclip -d paperclip"
