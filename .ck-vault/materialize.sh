#!/usr/bin/env bash
# ck-vault materializer — regenerate the credential files Divino's scripts read, FROM the vault.
# Flow: psql fetches divino-* secrets -> decrypt.mjs (in pc-build, has the master key) ->
#       substitute {{slug}} placeholders in templates/*.tmpl -> write target files (0600).
# Default is DRY-RUN (writes to a temp dir + diffs against the live files). Pass --apply to write.
set -euo pipefail

CO=e651858f-b11b-4b43-aa43-20c1192d7e98
V=/home/ckhermes/paperclip/.ck-vault
DA=/home/ckhermes/divino-agent
APPLY="${1:-}"
OUT="$(mktemp -d)"

# slug -> plaintext value, into an assoc array (values never printed)
declare -A VAL
while IFS= read -r line; do
  [ -z "$line" ] && continue
  name=$(printf '%s' "$line" | python3 -c 'import sys,json;print(json.loads(sys.stdin.read()).get("name",""))')
  # store raw JSON line keyed by name; we extract value at substitution time to avoid shell-mangling
  VAL["$name"]="$line"
done < <(
  docker exec pc-postgres psql -U paperclip -d ck_workforce -tA -c \
    "SELECT json_build_object('name',s.name,'description',s.description,'material',v.material)
       FROM company_secrets s
       JOIN company_secret_versions v ON v.secret_id=s.id AND v.version=s.latest_version
      WHERE s.company_id='$CO' AND s.name LIKE 'divino-%' AND s.deleted_at IS NULL" \
  | docker exec -i pc-build node /work/.ck-vault/decrypt.mjs
)

echo "vault secrets available: ${!VAL[*]}"

# render one template: replace {{slug}} with the decrypted value for that slug
render() {
  local tmpl="$1" dest="$2"
  python3 - "$tmpl" "$dest" <<'PY' "${VAL[@]:-}"
import re, sys, json
tmpl, dest = sys.argv[1], sys.argv[2]
vals = {}
for raw in sys.argv[3:]:
    o = json.loads(raw)
    vals[o["name"]] = o["value"]
text = open(tmpl).read()
missing = []
def sub(m):
    slug = m.group(1)
    if slug not in vals:
        missing.append(slug); return m.group(0)
    return vals[slug]
out = re.sub(r"\{\{([a-z0-9-]+)\}\}", sub, text)
if missing:
    sys.stderr.write(f"MISSING in vault for {tmpl}: {missing}\n"); sys.exit(3)
open(dest, "w").write(out)
PY
  chmod 600 "$dest"
}

# map: template -> live target path
declare -A MAP=(
  ["$V/templates/divino-mail.env.tmpl"]="$DA/workspace/.divino-mail.env"
  ["$V/templates/creds-anibis.txt.tmpl"]="$DA/workspace/.creds-anibis.txt"
  ["$V/templates/scripts.env.tmpl"]="$DA/secrets/scripts.env"
)

rc=0
for tmpl in "${!MAP[@]}"; do
  live="${MAP[$tmpl]}"
  base=$(basename "$live")
  render "$tmpl" "$OUT/$base"
  if [ "$APPLY" = "--apply" ]; then
    cp "$OUT/$base" "$live"; chmod 600 "$live"
    echo "WROTE  $live"
  else
    if diff -q "$live" "$OUT/$base" >/dev/null 2>&1; then
      echo "IDENTICAL  $base  (vault regenerates the live file byte-for-byte)"
    else
      echo "DIFFERS    $base  (showing live vs vault-generated; secret values are masked below)"
      diff <(sed -E 's/(PASS|KEY|password|API_KEY)([=:]).*/\1\2<masked>/' "$live") \
           <(sed -E 's/(PASS|KEY|password|API_KEY)([=:]).*/\1\2<masked>/' "$OUT/$base") || true
      rc=1
    fi
  fi
done
rm -rf "$OUT"
[ "$APPLY" = "--apply" ] || { echo; echo "DRY-RUN complete. Re-run with --apply to write."; }
exit $rc
