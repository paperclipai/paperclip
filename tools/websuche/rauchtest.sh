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
# SIGTERM allein prueft nichts: launchd startet einen KeepAlive=true-Dienst
# binnen 2-3s automatisch neu, lange bevor das CLI laeuft. bootout hebt die
# Registrierung auf, KeepAlive greift dann nicht mehr.

SEARXNG_PLIST="$HOME/Library/LaunchAgents/de.whitestag.searxng.plist"

searxng_lebt() {
  curl -sf "http://127.0.0.1:8888/search?q=test&format=json" >/dev/null 2>&1
}

# Sicherheitsnetz: laeuft auch, wenn das Skript vorzeitig abbricht (z.B. weil
# der Tot-Nachweis oder das CLI unerwartet haengt) — sonst bleibt der
# Suchdienst nach einem fehlgeschlagenen Rauchtest dauerhaft abgeschaltet.
searxng_wiederherstellen() {
  local i
  if ! launchctl print gui/$UID/de.whitestag.searxng >/dev/null 2>&1; then
    launchctl bootstrap gui/$UID "$SEARXNG_PLIST" 2>/dev/null
  fi
  for i in $(seq 1 15); do
    searxng_lebt && { echo "   SearXNG wiederhergestellt (nach ${i}s)."; return 0; }
    sleep 1
  done
  echo "   WARNUNG: SearXNG antwortet nach dem Wiederherstellungsversuch nicht — von Hand pruefen!" >&2
  return 1
}
trap searxng_wiederherstellen EXIT

echo "   Stoppe SearXNG per bootout..."
launchctl bootout gui/$UID/de.whitestag.searxng 2>/dev/null

TOT=0
for i in $(seq 1 15); do
  searxng_lebt || { TOT=1; break; }
  sleep 1
done
if [ $TOT -ne 1 ]; then
  echo "   FEHLGESCHLAGEN: SearXNG liess sich nach 15s nicht abschalten (Port 8888 weiterhin erreichbar)"
  exit 1
fi
echo "   SearXNG bestaetigt tot (nach ${i}s)."

OUT=$("$ZIEL/venv/bin/python" "$ZIEL/cli.py" "egal" 2>/tmp/websuche-fehler.txt)
CODE=$?
if [ $CODE -ne 0 ] && [ -z "$OUT" ]; then
  echo "   ok (Exit-Code $CODE, stdout leer): $(cat /tmp/websuche-fehler.txt)"
else
  echo "   FEHLGESCHLAGEN: Exit-Code $CODE, stdout: '$OUT'"
  exit 1
fi

searxng_wiederherstellen
trap - EXIT

echo "Rauchtest bestanden."
