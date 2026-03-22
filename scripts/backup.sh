#!/bin/bash

# Paperclip Automated Backup Script
# Creates backups of database and application data

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.prod.yml"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
RETENTION_DAYS=${RETENTION_DAYS:-30}

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Functions
print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_info() {
    echo -e "${YELLOW}→ $1${NC}"
}

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Timestamp
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
DATE_READABLE=$(date '+%Y-%m-%d %H:%M:%S')

print_info "Starting backup at $DATE_READABLE"

# === DATABASE BACKUP ===
print_info "Backing up database..."

DB_BACKUP_FILE="$BACKUP_DIR/paperclip-db-$TIMESTAMP.dump"

if docker-compose -f "$COMPOSE_FILE" exec -T db \
    pg_dump -U paperclip_prod -Fc paperclip_prod > "$DB_BACKUP_FILE" 2>/dev/null; then

    FILE_SIZE=$(du -h "$DB_BACKUP_FILE" | cut -f1)
    print_success "Database backup created: $(basename $DB_BACKUP_FILE) ($FILE_SIZE)"
else
    print_error "Database backup failed"
    exit 1
fi

# === APPLICATION DATA BACKUP ===
print_info "Backing up application data..."

DATA_BACKUP_FILE="$BACKUP_DIR/paperclip-data-$TIMESTAMP.tar.gz"

if docker run --rm \
    -v paperclip_paperclip-data:/data \
    -v "$BACKUP_DIR":/backup \
    alpine tar czf /backup/paperclip-data-$TIMESTAMP.tar.gz -C /data . 2>/dev/null; then

    FILE_SIZE=$(du -h "$DATA_BACKUP_FILE" | cut -f1)
    print_success "Application data backup created: $(basename $DATA_BACKUP_FILE) ($FILE_SIZE)"
else
    print_error "Application data backup failed"
    exit 1
fi

# === VERIFY BACKUPS ===
print_info "Verifying backups..."

if [ -s "$DB_BACKUP_FILE" ]; then
    print_success "Database backup verified"
else
    print_error "Database backup is empty or missing"
    exit 1
fi

if [ -s "$DATA_BACKUP_FILE" ]; then
    print_success "Application data backup verified"
else
    print_error "Application data backup is empty or missing"
    exit 1
fi

# === CLEANUP OLD BACKUPS ===
print_info "Cleaning up old backups (keeping last $RETENTION_DAYS days)..."

CUTOFF_DATE=$(date -d "$RETENTION_DAYS days ago" +%s 2>/dev/null || date -v-${RETENTION_DAYS}d +%s)

find "$BACKUP_DIR" -type f \( -name "*.dump" -o -name "*.tar.gz" \) | while read -r file; do
    FILE_DATE=$(stat -f %m "$file" 2>/dev/null || stat -c %Y "$file")

    if [ "$FILE_DATE" -lt "$CUTOFF_DATE" ]; then
        rm -f "$file"
        print_success "Removed old backup: $(basename $file)"
    fi
done

# === BACKUP SUMMARY ===
print_info "Backup Summary:"
echo ""
echo "  Backup Directory: $BACKUP_DIR"
echo "  Timestamp: $TIMESTAMP"
echo "  Database Backup: $(basename $DB_BACKUP_FILE)"
echo "  Data Backup: $(basename $DATA_BACKUP_FILE)"
echo "  Retention: $RETENTION_DAYS days"
echo ""

# List recent backups
echo "Recent backups:"
ls -lh "$BACKUP_DIR" | tail -5 | awk '{print "  " $9 " (" $5 ")"}'

print_success "Backup completed successfully"

# === OPTIONAL: UPLOAD TO REMOTE ===
if [ ! -z "$S3_BACKUP_BUCKET" ]; then
    print_info "Uploading backups to S3..."

    if command -v aws &> /dev/null; then
        aws s3 cp "$DB_BACKUP_FILE" "s3://$S3_BACKUP_BUCKET/" && \
        aws s3 cp "$DATA_BACKUP_FILE" "s3://$S3_BACKUP_BUCKET/" && \
        print_success "Backups uploaded to S3"
    else
        print_error "AWS CLI not found, skipping S3 upload"
    fi
fi

# === OPTIONAL: SEND NOTIFICATION ===
if [ ! -z "$SLACK_WEBHOOK" ]; then
    DB_SIZE=$(du -h "$DB_BACKUP_FILE" | cut -f1)
    DATA_SIZE=$(du -h "$DATA_BACKUP_FILE" | cut -f1)

    curl -X POST "$SLACK_WEBHOOK" \
        -H 'Content-Type: application/json' \
        -d "{\"text\":\"✓ Paperclip backup completed\",\"attachments\":[{\"color\":\"good\",\"fields\":[{\"title\":\"Database\",\"value\":\"$DB_SIZE\",\"short\":true},{\"title\":\"Data\",\"value\":\"$DATA_SIZE\",\"short\":true},{\"title\":\"Time\",\"value\":\"$DATE_READABLE\",\"short\":false}]}]}" \
        2>/dev/null
fi

exit 0
