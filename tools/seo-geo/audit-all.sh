#!/usr/bin/env bash
# Woechentliche SEO/GEO-Audit-Routine: auditiert ALLE Sites aus sites.json
# deterministisch (kein LLM), schreibt je Site report.json/report.md, erzeugt
# eine datierte Ampel-Summary und mailt sie via Mailhub an Walter.
#
# Laeuft als launchd-Job (ing.whitestag.seo-geo-audit) Montag 05:00.
# Muss aus ~/.paperclip/scripts/ laufen (CloudStorage ist fuer launchd unlesbar).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

# Credentials fuer den WP-Crawl
# shellcheck disable=SC1090
source "$HOME/.whitestag.env" 2>/dev/null || true

PY="$HERE/venv/bin/python"
SITES="$HERE/sites.json"

# Site-Namen aus sites.json ziehen (portabel, kein mapfile — macOS bash 3.2)
NAMES=()
while IFS= read -r line; do
  [ -n "$line" ] && NAMES+=("$line")
done < <("$PY" -c "import json;print('\n'.join(s['name'] for s in json.load(open('$SITES'))['sites']))")

echo "[$(date '+%F %T')] Audit-Lauf: ${NAMES[*]:-KEINE}"
for name in "${NAMES[@]}"; do
  echo "--- audit $name ---"
  "$PY" cli.py audit --site "$name" --sites "$SITES" || echo "WARN: audit $name fehlgeschlagen"
done

# Summary erzeugen (schreibt _audit-history/<datum>.{json,md})
BODY="$(mktemp -t seo-audit-body.XXXXXX.md)"
"$PY" audit_summary.py --sites "$SITES" --out "$BODY" || { echo "Summary fehlgeschlagen"; exit 2; }
cat "$BODY"

# Mail via Sekretaerin-Mailhub-Skript (falls vorhanden)
SEND="$HOME/.paperclip/instances/default/companies/9cebf3cf-efe8-4597-a400-f06488900a87/agents/e24b8d9d-143e-4141-b413-4361aa618771/bin/send-walter-report.sh"
DATE="$(date '+%F')"
# Pfad geht vom Default-report_root ("~/.paperclip/seo-geo") aus (siehe sites.json).
# Wird report_root dort je auf einen anderen Wert gesetzt, muss dieser Pfad mitgezogen werden.
ALERT_FILE="$HOME/.paperclip/seo-geo/_audit-history/${DATE}-alert.txt"
SUBJECT="SEO/GEO Wochen-Audit ${DATE}"
if [[ -f "$ALERT_FILE" ]] && [[ "$(cat "$ALERT_FILE")" == "ALERT" ]]; then
  SUBJECT="⚠️ SEO/GEO Wochen-Audit ${DATE} — Verschlechterung"
fi
if [[ -x "$SEND" ]]; then
  "$SEND" "$SUBJECT" "$BODY" && echo "Mail versendet ($SUBJECT)" || echo "WARN: Mailversand fehlgeschlagen"
else
  echo "WARN: send-walter-report.sh nicht gefunden — nur History geschrieben."
fi

rm -f "$BODY"
echo "[$(date '+%F %T')] Audit-Lauf fertig."
