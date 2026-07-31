#!/usr/bin/env bash
set -euo pipefail

SCRIPT="${1:-$(dirname "$0")/paperclip-mempalace-backup.sh}"
FIXTURE="$(mktemp -d)"
trap 'rm -rf -- "$FIXTURE"' EXIT

bash -n "$SCRIPT"

touch -d '20 days ago' "$FIXTURE/paperclip_mempalace_20200101T000000Z.tar.gz"
touch -d '20 days ago' "$FIXTURE/paperclip_mempalace_20200101T000000Z.sha256"
touch -d '20 days ago' "$FIXTURE/paperclip_mempalace_20200101T000000Z.inventory.txt"
touch -d '20 days ago' "$FIXTURE/paperclip_mempalace_20200101T000000Z.counts.json"
touch -d '20 days ago' "$FIXTURE/paperclip_mempalace_20200101T000000Z.restore.json"
touch -d '10 days ago' "$FIXTURE/paperclip_mempalace_20200102T000000Z.tar.gz"
touch -d '10 days ago' "$FIXTURE/paperclip_mempalace_20200102T000000Z.sha256"
touch -d '10 days ago' "$FIXTURE/paperclip_mempalace_20200102T000000Z.inventory.txt"
touch -d '1 day ago' "$FIXTURE/paperclip_mempalace_20200103T000000Z.tar.gz"

dry_run="$(DEST_DIR="$FIXTURE" RETENTION_DAYS=7 "$SCRIPT" --dry-run-retention)"
printf '%s\n' "$dry_run" | grep -q '20200101T000000Z.tar.gz'
printf '%s\n' "$dry_run" | grep -q '20200102T000000Z.tar.gz'
if printf '%s\n' "$dry_run" | grep -q '20200103T000000Z.tar.gz'; then
  echo "retention dry-run selected the newest archive" >&2
  exit 1
fi

DEST_DIR="$FIXTURE" RETENTION_DAYS=7 "$SCRIPT" --retention-only
[ ! -e "$FIXTURE/paperclip_mempalace_20200101T000000Z.tar.gz" ]
[ ! -e "$FIXTURE/paperclip_mempalace_20200101T000000Z.sha256" ]
[ ! -e "$FIXTURE/paperclip_mempalace_20200101T000000Z.inventory.txt" ]
[ ! -e "$FIXTURE/paperclip_mempalace_20200101T000000Z.counts.json" ]
[ ! -e "$FIXTURE/paperclip_mempalace_20200101T000000Z.restore.json" ]
[ ! -e "$FIXTURE/paperclip_mempalace_20200102T000000Z.tar.gz" ]
[ -e "$FIXTURE/paperclip_mempalace_20200103T000000Z.tar.gz" ]

# The newest archive is retained even if every archive is older than the window.
touch -d '20 days ago' "$FIXTURE/paperclip_mempalace_20200103T000000Z.tar.gz"
DEST_DIR="$FIXTURE" RETENTION_DAYS=7 "$SCRIPT" --retention-only
[ -e "$FIXTURE/paperclip_mempalace_20200103T000000Z.tar.gz" ]

echo "backup retention fixture: PASS"
