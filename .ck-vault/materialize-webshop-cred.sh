#!/usr/bin/env bash
# Regenerate the webshop admin Basic-auth cred file FROM the vault secret
# "Divino-webshop-admin" (the divino-ops Money panel reads it via
# DIVINO_WEBSHOP_ADMIN_FILE). The vault stores the PASSWORD only; the webshop
# username is ADMIN_USER (default "admin"), so the file is "admin:<password>".
# Idempotent + 0600; only rewrites when the value changed (so a GUI rotation
# flows through within the sync-cron interval). Plaintext never printed.
set -euo pipefail
CO=e651858f-b11b-4b43-aa43-20c1192d7e98
DEST=/home/ckhermes/.secrets/divino-webshop-admin.cred
USER_NAME="${WEBSHOP_ADMIN_USER:-admin}"

json=$(docker exec pc-postgres psql -U paperclip -d ck_workforce -tA -c \
  "SELECT json_build_object('name',s.name,'description',s.description,'material',v.material)
     FROM company_secrets s
     JOIN company_secret_versions v ON v.secret_id=s.id AND v.version=s.latest_version
    WHERE s.company_id='$CO' AND s.name='Divino-webshop-admin' AND s.deleted_at IS NULL" \
  | docker exec -i pc-build node /work/.ck-vault/decrypt.mjs)

[ -z "$json" ] && { echo "no secret found in vault" >&2; exit 1; }

umask 077
printf '%s' "$json" | USER_NAME="$USER_NAME" DEST="$DEST" python3 -c '
import json,sys,os
o=json.loads(sys.stdin.read())
pw=o["value"]
cred=os.environ["USER_NAME"]+":"+pw
dest=os.environ["DEST"]
old=open(dest).read() if os.path.exists(dest) else ""
if old==cred:
    sys.exit(0)  # unchanged
open(dest,"w").write(cred); os.chmod(dest,0o600)
print("WROTE "+dest)
'
