#!/bin/zsh
# Rauchtest gegen die ECHTEN lokalen Dienste. Bewusst nicht Teil der
# pytest-Suite: die muss ohne Netzzugang durchlaufen.
set -u

ZIEL="$HOME/.paperclip/scripts/websuche"
FRAGE="${1:-Foerdermittel Digitalisierung NRW 2026}"

echo "== 1. SearXNG erreichbar?"
curl -sf "http://127.0.0.1:8888/search?q=test&format=json" >/dev/null \
  && echo "   ok" || { echo "   FEHLGESCHLAGEN"; exit 1; }

echo "== 2. Dienst erreichbar?"
curl -sf "http://127.0.0.1:7789/" >/dev/null \
  && echo "   ok" || { echo "   FEHLGESCHLAGEN"; exit 1; }

echo "== 3. CLI, drei Quellen, Laufzeit messen"
START=$(date +%s)
"$ZIEL/venv/bin/python" "$ZIEL/cli.py" "$FRAGE" --json > /tmp/websuche-rauchtest.json
CODE=$?
DAUER=$(( $(date +%s) - START ))
echo "   Exit-Code $CODE, $DAUER s"
[ $CODE -eq 0 ] || { echo "   FEHLGESCHLAGEN"; exit 1; }
[ $DAUER -le 25 ] || echo "   WARNUNG: ueber der 25s-Deadline"

python3 - <<'PY'
import json
d = json.load(open("/tmp/websuche-rauchtest.json"))
domains = [q["domain"] for q in d["quellen"]]
mit_text = [q for q in d["quellen"] if "text" in q]
print(f"   Domains: {domains}")
print(f"   Quellen mit Text: {len(mit_text)}")
print(f"   Hinweis: {d['hinweis']}")
assert len(set(domains)) == len(domains), "Domains nicht eindeutig!"
assert all(q.get("abgerufen_am") for q in d["quellen"]), "Abrufdatum fehlt!"
PY

echo "== 4. Backend-Ausfall gibt Exit-Code ungleich null"
launchctl kill SIGTERM gui/$UID/de.whitestag.searxng 2>/dev/null
sleep 3
"$ZIEL/venv/bin/python" "$ZIEL/cli.py" "egal" >/dev/null 2>/tmp/websuche-fehler.txt
CODE=$?
launchctl kickstart gui/$UID/de.whitestag.searxng
if [ $CODE -ne 0 ]; then
  echo "   ok (Exit-Code $CODE): $(cat /tmp/websuche-fehler.txt)"
else
  echo "   FEHLGESCHLAGEN: Exit-Code 0 trotz totem Backend"; exit 1
fi

echo "Rauchtest bestanden."
