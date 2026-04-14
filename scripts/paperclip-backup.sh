#!/bin/bash
# Paperclip server backup → Telegram
# Runs inside the container. Reads Telegram credentials from the database
# (via DATABASE_URL env var) and sends an archive of /paperclip/instances.
#
# Usage: paperclip-backup
# Scheduled every 6 hours via cron (installed by docker-entrypoint.sh)

set -euo pipefail

BACKUP_DIR="/tmp/paperclip-backups"
LOCK_DIR="/tmp/paperclip-backup.lock"
DATE=$(date +%Y%m%d_%H%M%S)
ARCHIVE="$BACKUP_DIR/paperclip_backup_$DATE.tar.gz"

mkdir -p "$BACKUP_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "[backup] Another backup is already running; skipping."
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

# ── Fresh DB dump before archiving ───────────────────────────────────────────
# Paperclip stores hourly DB dumps in /paperclip/instances/default/data/backups
# We trigger a fresh pg_dump so the archive always has an up-to-date snapshot.
DB_BACKUP_DIR="/paperclip/instances/default/data/backups"
mkdir -p "$DB_BACKUP_DIR"
if [ -n "${DATABASE_URL:-}" ] && command -v pg_dump >/dev/null 2>&1; then
  echo "[backup] Running fresh pg_dump..."
  PGSSLMODE=require pg_dump "$DATABASE_URL" \
    --no-password --format=custom \
    -f "$DB_BACKUP_DIR/manual_$(date +%Y%m%d_%H%M%S).dump" 2>/dev/null \
    && echo "[backup] pg_dump done" || echo "[backup] pg_dump failed (non-fatal)"
fi

# ── Create archive ────────────────────────────────────────────────────────────
echo "[backup] Creating archive of /paperclip/instances (includes DB dumps)..."
tar -I 'gzip -1' -cf "$ARCHIVE" -C /paperclip instances/ 2>/dev/null

SIZE=$(du -sh "$ARCHIVE" 2>/dev/null | cut -f1)
AGENTS_COUNT=$(find /paperclip/instances/default/agents -name "AGENTS.md" 2>/dev/null | wc -l | tr -d ' ')
CODEX_COUNT=$(find /paperclip/instances -path "*/codex-home/*" -name "AGENTS.md" 2>/dev/null | wc -l | tr -d ' ')
DB_DUMPS=$(find "$DB_BACKUP_DIR" -name "*.dump" 2>/dev/null | wc -l | tr -d ' ')
HOSTNAME_VAL=$(hostname 2>/dev/null || echo "unknown")

echo "[backup] Archive: $ARCHIVE ($SIZE), agents: $AGENTS_COUNT, codex plugins: $CODEX_COUNT"

# ── Read Telegram credentials from DB ────────────────────────────────────────
if [ -z "${DATABASE_URL:-}" ]; then
  echo "[backup] WARNING: DATABASE_URL not set; skipping Telegram"
  exit 0
fi

# Find the pg module path
PG_PATH=$(ls -d /app/node_modules/.pnpm/pg@*/node_modules/pg 2>/dev/null | head -1 || echo "")
if [ -z "$PG_PATH" ]; then
  echo "[backup] WARNING: pg module not found; skipping Telegram"
  exit 0
fi

CREDS=$(NODE_TLS_REJECT_UNAUTHORIZED=0 PG_MOD="$PG_PATH" node -e "
const { Pool } = require(process.env.PG_MOD);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(
  \"SELECT pc.config_json FROM plugin_config pc JOIN plugins p ON p.id = pc.plugin_id WHERE p.plugin_key = 'telegram' LIMIT 1\",
  (err, res) => {
    if (err || !res.rows.length) { process.stdout.write('{}'); pool.end(); return; }
    const cfg = res.rows[0].config_json;
    process.stdout.write(JSON.stringify({
      t: cfg.botToken || '',
      c: cfg.notifyChatId || cfg.personalChatId || ''
    }));
    pool.end();
  }
);
" 2>/dev/null || echo "{}")

BOT_TOKEN=$(echo "$CREDS" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(d.t||'')}catch(e){}" 2>/dev/null || true)
CHAT_ID=$(echo  "$CREDS" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(d.c||'')}catch(e){}" 2>/dev/null || true)

if [ -z "$BOT_TOKEN" ] || [ -z "$CHAT_ID" ]; then
  echo "[backup] WARNING: Could not read Telegram credentials; skipping send"
  exit 0
fi

# ── Send summary message ──────────────────────────────────────────────────────
MSG="🗄 *Paperclip Backup*
📅 $(date '+%Y-%m-%d %H:%M UTC')
📦 Size: $SIZE
🤖 Agents with instructions: $AGENTS_COUNT
🔌 Codex plugins (AGENTS.md): $CODEX_COUNT
🗃 DB dumps in archive: $DB_DUMPS
🔧 Machine: $HOSTNAME_VAL
✅ Status: OK"

curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -d "chat_id=${CHAT_ID}" \
  -d "parse_mode=Markdown" \
  --data-urlencode "text=${MSG}" > /dev/null \
  && echo "[backup] Summary sent to Telegram"

# ── Send archive file ─────────────────────────────────────────────────────────
curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendDocument" \
  -F "chat_id=${CHAT_ID}" \
  -F "document=@${ARCHIVE}" \
  -F "caption=Backup ${DATE}" > /dev/null \
  && echo "[backup] Archive sent to Telegram"

# ── Cleanup (keep last 3) ─────────────────────────────────────────────────────
ls -t "$BACKUP_DIR"/paperclip_backup_*.tar.gz 2>/dev/null | tail -n +4 | xargs rm -f 2>/dev/null || true

echo "[backup] Done."
