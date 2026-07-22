#!/usr/bin/env bash
# Re-materialize Divino's credential files from the vault ONLY when they differ (i.e. a rotation
# happened in the Paperclip GUI). Invoked by cron every 15 min. Safe: never writes a broken file.
cd /home/ckhermes/paperclip/.ck-vault || exit 1

# Webshop admin cred (own file, own secret) — idempotent, only writes on change. Runs every time,
# independent of the template files below.
bash /home/ckhermes/paperclip/.ck-vault/materialize-webshop-cred.sh >> sync.log 2>&1 || true

if bash materialize.sh >/dev/null 2>&1; then
  exit 0   # live template files already match the vault — nothing to do
fi
echo "$(date -Is) vault differs -> applying" >> sync.log
bash materialize.sh --apply >> sync.log 2>&1
