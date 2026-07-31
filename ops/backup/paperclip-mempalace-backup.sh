#!/usr/bin/env bash
set -euo pipefail

# Host-level Paperclip backup. The logical dump created by the supported
# Paperclip CLI is the database restore authority; the live embedded-Postgres
# data directory is intentionally excluded from the filesystem archive.

DEST_DIR="${DEST_DIR:-/var/backups/paperclip-mempalace}"
INSTANCE_DIR="${INSTANCE_DIR:-/home/beai-agent/.paperclip/instances/default}"
PAPERCLIP_RELEASE_DIR="${PAPERCLIP_RELEASE_DIR:-/mnt/paperclipdata/paperclip-releases/paperclip-backup-restore-authority-v1}"
PAPERCLIP_CONFIG="${PAPERCLIP_CONFIG:-$INSTANCE_DIR/config.json}"
LOGICAL_BACKUP_DIR="${LOGICAL_BACKUP_DIR:-$INSTANCE_DIR/data/backups}"
STORAGE_DIR="${STORAGE_DIR:-$INSTANCE_DIR/data/storage}"
MASTER_KEY="${MASTER_KEY:-$INSTANCE_DIR/secrets/master.key}"
MEMPALACE_HOME="${MEMPALACE_HOME:-/home/beai-agent/.mempalace}"
MEMPALACE_VOLUME="${MEMPALACE_VOLUME:-/mnt/volume_1783102943473/mempalace}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
LOGICAL_RETENTION_DAYS="${LOGICAL_RETENTION_DAYS:-30}"
MIN_DEST_FREE_KIB="${MIN_DEST_FREE_KIB:-8388608}"
BACKUP_OWNER="${BACKUP_OWNER:-beai-agent:beai-agent}"
LOCK="${LOCK:-/tmp/paperclip_mempalace_backup.lock}"
MINE_LOCK="${MINE_LOCK:-/tmp/mempalace_mine_codex.lock}"
DRY_RUN_RETENTION=0
RETENTION_ONLY=0

usage() {
  echo "usage: $0 [--retention-only] [--dry-run-retention]" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --retention-only) RETENTION_ONLY=1 ;;
    --dry-run-retention) RETENTION_ONLY=1; DRY_RUN_RETENTION=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 64 ;;
  esac
  shift
done

require_positive_integer() {
  case "$2" in
    ''|*[!0-9]*|0) echo "ERROR: $1 must be a positive integer" >&2; exit 64 ;;
  esac
}

require_positive_integer RETENTION_DAYS "$RETENTION_DAYS"
require_positive_integer LOGICAL_RETENTION_DAYS "$LOGICAL_RETENTION_DAYS"
require_positive_integer MIN_DEST_FREE_KIB "$MIN_DEST_FREE_KIB"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

run_retention() {
  local newest archive base
  newest="$(find "$DEST_DIR" -maxdepth 1 -type f -name 'paperclip_mempalace_*.tar.gz' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n1 | cut -d' ' -f2-)"

  while IFS= read -r -d '' archive; do
    [ -n "$newest" ] && [ "$archive" = "$newest" ] && continue
    base="${archive%.tar.gz}"
    if [ "$DRY_RUN_RETENTION" -eq 1 ]; then
      printf 'would-delete %s\n' "$archive"
      [ -e "$base.sha256" ] && printf 'would-delete %s\n' "$base.sha256"
      [ -e "$base.inventory.txt" ] && printf 'would-delete %s\n' "$base.inventory.txt"
      [ -e "$base.counts.json" ] && printf 'would-delete %s\n' "$base.counts.json"
      [ -e "$base.restore.json" ] && printf 'would-delete %s\n' "$base.restore.json"
    else
      rm -f -- "$archive" "$base.sha256" "$base.inventory.txt" \
        "$base.counts.json" "$base.restore.json"
      log "retention deleted $archive and matching sidecars"
    fi
  done < <(find "$DEST_DIR" -maxdepth 1 -type f -name 'paperclip_mempalace_*.tar.gz' -mtime "+$RETENTION_DAYS" -print0)
}

mkdir -p "$DEST_DIR"

if [ "$RETENTION_ONLY" -eq 1 ]; then
  run_retention
  exit 0
fi

for command_name in corepack flock gzip jq sha256sum tar; do
  command -v "$command_name" >/dev/null || {
    echo "ERROR: required command not found: $command_name" >&2
    exit 1
  }
done

mountpoint -q /mnt/paperclipdata || {
  echo "ERROR: /mnt/paperclipdata is not mounted" >&2
  exit 1
}

for required_path in "$PAPERCLIP_CONFIG" "$STORAGE_DIR" "$MASTER_KEY" "$PAPERCLIP_RELEASE_DIR/package.json"; do
  [ -e "$required_path" ] || {
    echo "ERROR: required path missing: $required_path" >&2
    exit 1
  }
done

jq -e . "$PAPERCLIP_CONFIG" >/dev/null

dest_device="$(df -P "$DEST_DIR" | awk 'NR==2 {print $1}')"
instance_device="$(df -P "$INSTANCE_DIR" | awk 'NR==2 {print $1}')"
[ "$dest_device" != "$instance_device" ] || {
  echo "ERROR: destination must be on a different filesystem from the live Paperclip instance" >&2
  exit 1
}

dest_free_kib="$(df -Pk "$DEST_DIR" | awk 'NR==2 {print $4}')"
[ "$dest_free_kib" -ge "$MIN_DEST_FREE_KIB" ] || {
  echo "ERROR: destination has ${dest_free_kib} KiB free; require ${MIN_DEST_FREE_KIB} KiB" >&2
  exit 1
}

exec 9>"$LOCK"
flock -n 9 || {
  log "backup already running; exiting without overlap"
  exit 0
}

if [ -r "$MINE_LOCK" ] && exec 8<"$MINE_LOCK"; then
  log "waiting for MemPalace mine lock"
  flock -w 10800 8 || {
    echo "ERROR: MemPalace mine lock wait timed out" >&2
    exit 1
  }
fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
PREFIX="paperclip-host-${TS}"
ARCHIVE="$DEST_DIR/paperclip_mempalace_${TS}.tar.gz"
PARTIAL="$ARCHIVE.partial"
INVENTORY="${ARCHIVE%.tar.gz}.inventory.txt"
MANIFEST="${ARCHIVE%.tar.gz}.sha256"
COUNT_LEDGER="${ARCHIVE%.tar.gz}.counts.json"
RESTORE_MANIFEST="${ARCHIVE%.tar.gz}.restore.json"
WORK_DIR="$(mktemp -d "$DEST_DIR/.paperclip-backup.${TS}.XXXXXX")"

cleanup() {
  rm -f -- "$PARTIAL"
  rm -f -- "$COUNT_LEDGER" "$RESTORE_MANIFEST" "$RESTORE_MANIFEST.partial"
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT

log "creating authoritative logical backup with Paperclip CLI"
corepack pnpm --dir "$PAPERCLIP_RELEASE_DIR" paperclipai db:backup \
  --config "$PAPERCLIP_CONFIG" \
  --dir "$LOGICAL_BACKUP_DIR" \
  --retention-days "$LOGICAL_RETENTION_DAYS" \
  --filename-prefix "$PREFIX" \
  --ledger-file "$COUNT_LEDGER" \
  --json >"$WORK_DIR/db-backup.log"

LOGICAL_BACKUP="$(find "$LOGICAL_BACKUP_DIR" -maxdepth 1 -type f -name "${PREFIX}-*.sql.gz" -print -quit)"
[ -n "$LOGICAL_BACKUP" ] || {
  echo "ERROR: Paperclip CLI did not produce the expected logical backup" >&2
  exit 1
}
gzip -t "$LOGICAL_BACKUP"

BACKUP_SHA256="$(sha256sum "$LOGICAL_BACKUP" | awk '{print $1}')"
LEDGER_SHA256="$(sha256sum "$COUNT_LEDGER" | awk '{print $1}')"
BACKUP_SIZE_BYTES="$(stat -c %s "$LOGICAL_BACKUP")"
RESTORE_FOOTPRINT_BYTES="$(jq -er '.databaseSizeBytes | select(type == "number" and . >= 0 and floor == .)' "$COUNT_LEDGER")"
jq -S -n \
  --arg backup_file "$(basename "$LOGICAL_BACKUP")" \
  --arg backup_sha256 "$BACKUP_SHA256" \
  --argjson backup_size_bytes "$BACKUP_SIZE_BYTES" \
  --arg ledger_file "$(basename "$COUNT_LEDGER")" \
  --arg ledger_sha256 "$LEDGER_SHA256" \
  --argjson restore_footprint_bytes "$RESTORE_FOOTPRINT_BYTES" \
  '{
    format: "paperclip-restore-authority-v1",
    backup: {file: $backup_file, sha256: $backup_sha256, sizeBytes: $backup_size_bytes},
    ledger: {file: $ledger_file, sha256: $ledger_sha256},
    restoreFootprintBytes: $restore_footprint_bytes
  }' >"$RESTORE_MANIFEST.partial"
mv -f -- "$RESTORE_MANIFEST.partial" "$RESTORE_MANIFEST"

component_inventory() {
  local label path kind bytes entries
  label="$1"
  path="$2"
  if [ -d "$path" ]; then
    kind=directory
    bytes="$(du -sb "$path" | awk '{print $1}')"
    entries="$(find "$path" -xdev -mindepth 1 | wc -l)"
  else
    kind=file
    bytes="$(stat -c %s "$path")"
    entries=1
  fi
  printf '%s\ttype=%s\tbytes=%s\tentries=%s\n' "$label" "$kind" "$bytes" "$entries"
}

{
  printf 'created_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'database_restore_authority=logical_backup\n'
  printf 'live_embedded_postgres_directory_included=false\n'
  printf 'logical_retention_days=%s\n' "$LOGICAL_RETENTION_DAYS"
  printf 'filesystem_retention_days=%s\n' "$RETENTION_DAYS"
  component_inventory paperclip_config "$PAPERCLIP_CONFIG"
  component_inventory secrets_master_key "$MASTER_KEY"
  component_inventory local_storage "$STORAGE_DIR"
  component_inventory logical_database_backup "$LOGICAL_BACKUP"
  component_inventory backup_time_count_ledger "$COUNT_LEDGER"
  component_inventory restore_authority_manifest "$RESTORE_MANIFEST"
  [ ! -d "$MEMPALACE_HOME" ] || component_inventory mempalace_home "$MEMPALACE_HOME"
  [ ! -d "$MEMPALACE_VOLUME" ] || component_inventory mempalace_volume "$MEMPALACE_VOLUME"
} >"$INVENTORY"

tar_args=(
  -C /
  "${PAPERCLIP_CONFIG#/}"
  "${MASTER_KEY#/}"
  "${STORAGE_DIR#/}"
  "${LOGICAL_BACKUP#/}"
  "${COUNT_LEDGER#/}"
  "${RESTORE_MANIFEST#/}"
  "${INVENTORY#/}"
)
[ ! -d "$MEMPALACE_HOME" ] || tar_args+=("${MEMPALACE_HOME#/}")
[ ! -d "$MEMPALACE_VOLUME" ] || tar_args+=("${MEMPALACE_VOLUME#/}")

log "creating filesystem archive (live embedded-Postgres directory excluded)"
tar -czf "$PARTIAL" "${tar_args[@]}"
gzip -t "$PARTIAL"
mv -f -- "$PARTIAL" "$ARCHIVE"

(
  cd "$DEST_DIR"
  sha256sum \
    "$(basename "$ARCHIVE")" \
    "$(basename "$INVENTORY")" \
    "$(basename "$COUNT_LEDGER")" \
    "$(basename "$RESTORE_MANIFEST")" >"$(basename "$MANIFEST").partial"
  mv -f -- "$(basename "$MANIFEST").partial" "$(basename "$MANIFEST")"
  sha256sum -c "$(basename "$MANIFEST")"
)

chown "$BACKUP_OWNER" "$ARCHIVE" "$INVENTORY" "$MANIFEST" "$COUNT_LEDGER" \
  "$RESTORE_MANIFEST" "$LOGICAL_BACKUP"
chmod 0640 "$ARCHIVE" "$INVENTORY" "$MANIFEST" "$COUNT_LEDGER" \
  "$RESTORE_MANIFEST" "$LOGICAL_BACKUP"

run_retention
trap - EXIT
rm -rf -- "$WORK_DIR"
log "backup complete: $ARCHIVE"
log "manifest: $MANIFEST"
