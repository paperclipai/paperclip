# Backup e Restore — Toca da IA

## Backup automático

### Ambiente Docker (produção)

```bash
./scripts/backup-docker.sh
# Salva em: backups/backup_YYYYMMDD_HHMMSS.sql.gz
```

Especificando destino:
```bash
./scripts/backup-docker.sh --output /mnt/storage/backup.sql.gz
```

### Agendar backup diário (cron)

```bash
# Editar crontab
crontab -e

# Backup às 3h da manhã todos os dias
0 3 * * * cd /opt/toca-da-ia && ./scripts/backup-docker.sh >> /var/log/toca-backup.log 2>&1
```

## Restore

### A partir de backup `.sql.gz`

```bash
# 1. Identificar o container do banco
DB_CONTAINER=$(docker compose -f docker/docker-compose.prod.yml ps -q db)

# 2. Restaurar
gunzip -c backups/backup_YYYYMMDD_HHMMSS.sql.gz \
  | docker exec -i "$DB_CONTAINER" psql -U paperclip -d paperclip
```

> **Atenção:** o restore sobrescreve os dados existentes no banco. Faça um backup antes de restaurar.

## O que está incluído no backup

| Dado | Incluído | Local |
|------|----------|-------|
| Banco de dados (PostgreSQL) | ✅ | `backups/*.sql.gz` |
| Dados de arquivos (uploads, dados de agente) | ✅ | Volume `app-data` (`/paperclip`) |
| Configurações (variáveis de ambiente) | ✅ | `.env` |

### Backup do volume de dados (uploads)

```bash
docker run --rm \
  -v toca-da-ia_app-data:/source:ro \
  -v $(pwd)/backups:/backup \
  alpine tar czf /backup/app-data_$(date +%Y%m%d_%H%M%S).tar.gz -C /source .
```

### Restore do volume de dados

```bash
# Parar o app antes
docker compose -f docker/docker-compose.prod.yml stop app

docker run --rm \
  -v toca-da-ia_app-data:/target \
  -v $(pwd)/backups:/backup \
  alpine tar xzf /backup/app-data_YYYYMMDD_HHMMSS.tar.gz -C /target

# Reiniciar
docker compose -f docker/docker-compose.prod.yml start app
```

## Estratégia recomendada

- **Backup diário** do banco via cron
- **Retenção** de 30 dias (remova arquivos mais antigos automaticamente)
- **Backup semanal** do volume de dados
- **Testar restore** mensalmente em ambiente separado

```bash
# Remover backups com mais de 30 dias
find backups/ -name "backup_*.sql.gz" -mtime +30 -delete
```
