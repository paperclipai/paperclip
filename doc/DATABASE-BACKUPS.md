# Database Backup & Restore Runbook

## Overview

Paperclip includes a built-in PostgreSQL backup system that runs automatically inside the server process. Backups are SQL dumps (gzipped) stored on the application volume.

## Configuration

| Environment Variable                   | Default                                    | Description                      |
| -------------------------------------- | ------------------------------------------ | -------------------------------- |
| `PAPERCLIP_DB_BACKUP_ENABLED`          | `true`                                     | Enable/disable automatic backups |
| `PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES` | `60`                                       | Interval between backups         |
| `PAPERCLIP_DB_BACKUP_RETENTION_DAYS`   | `30`                                       | Days to keep old backups         |
| `PAPERCLIP_DB_BACKUP_DIR`              | `~/.paperclip/instances/{id}/data/backups` | Backup storage directory         |

These are set in `deploy/docker-compose.dokploy.yml` for production.

## Backup Location

In production (Dokploy), backups are stored on the `paperclip-data` Docker volume at:

```
/paperclip/instances/default/data/backups/
```

Files follow the naming pattern: `paperclip-YYYYMMDD-HHMMSS.sql`

## Manual Backup

### Via CLI

```bash
pnpm paperclipai db:backup --dir /path/to/output
```

Options:

- `--dir` — Output directory (default: configured backup dir)
- `--retention-days` — Override retention policy
- `--filename-prefix` — Custom prefix (default: `paperclip`)
- `--json` — JSON output

### Via Docker exec (production)

```bash
# Enter the running paperclip container
docker exec -it <container-id> bash

# Run manual backup
pnpm paperclipai db:backup --dir /paperclip/instances/default/data/backups

# Copy backup file to host
docker cp <container-id>:/paperclip/instances/default/data/backups/<filename> ./
```

### Via pg_dump (direct PostgreSQL dump)

```bash
# From a machine with access to the database
docker exec <postgres-container-id> pg_dump -U $POSTGRES_USER $POSTGRES_DB > backup.sql

# Or with compression
docker exec <postgres-container-id> pg_dump -U $POSTGRES_USER $POSTGRES_DB | gzip > backup.sql.gz
```

## Restore Procedure

### Prerequisites

- A backup file (`.sql` or gzipped `.sql`)
- Access to the target PostgreSQL database
- **Warning**: Restore replaces all data in the target database

### Steps

1. **Stop the application** to prevent writes during restore:

```bash
docker compose -f deploy/docker-compose.dokploy.yml stop paperclip
```

2. **Restore using psql** (recommended for pg_dump backups):

```bash
# Drop and recreate the database
docker exec -it <postgres-container> psql -U $POSTGRES_USER -c "DROP DATABASE IF EXISTS $POSTGRES_DB;"
docker exec -it <postgres-container> psql -U $POSTGRES_USER -c "CREATE DATABASE $POSTGRES_DB;"

# Restore
cat backup.sql | docker exec -i <postgres-container> psql -U $POSTGRES_USER $POSTGRES_DB
```

3. **Restore using the built-in restore** (for Paperclip SQL dumps):

```bash
# Inside the paperclip container
pnpm paperclipai db:restore --file /path/to/backup.sql
```

4. **Restart the application**:

```bash
docker compose -f deploy/docker-compose.dokploy.yml start paperclip
```

5. **Verify** by checking the health endpoint:

```bash
curl https://$PAPERCLIP_DOMAIN/api/health
```

## Monitoring

Backup operations are logged to stdout with timestamps. Check container logs for backup status:

```bash
docker logs <paperclip-container-id> 2>&1 | grep -i backup
```

Look for:

- `Backup completed` — successful backup with file path and size
- `Backup failed` — error details
- `Pruned N old backups` — retention cleanup

## Known Limitations

1. **Single-host storage**: Backups are stored on the same Docker volume as the app. If the host is lost, backups are lost too. Consider periodic off-host copies (S3, rsync, etc.).
2. **Application-level scheduling**: Backups run via `setInterval()` in Node.js. If the server crashes, backups stop until restart.
3. **No automated verification**: Backup integrity is not automatically verified. Periodic manual restore tests are recommended.
