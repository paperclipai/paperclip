#!/bin/zsh
# Rauchtest gegen die ECHTEN lokalen Dienste. Bewusst nicht Teil der
# pytest-Suite: die muss ohne Netzzugang durchlaufen.
set -u
zmodload zsh/datetime    # $EPOCHREALTIME: Laufzeit unter einer Sekunde messbar

ZIEL="$HOME/.paperclip/scripts/websuche"
FRAGE="${1:-Foerdermittel Digitalisierung NRW 2026}"

# Erfolgskriterium 2 der Spec: drei Quellen auf drei Domains, jede mit Text,
# innerhalb der Standard-Deadline.
MINDEST_QUELLEN=3
MAX_SEKUNDEN=25.0

echo "== 1. SearXNG erreichbar?"
curl -sf "http://127.0.0.1:8888/search?q=test&format=json" >/dev/null \
  && echo "   ok" || { echo "   FEHLGESCHLAGEN"; exit 1; }

echo "== 2. Dienst erreichbar?"
curl -sf "http://127.0.0.1:7789/" >/dev/null \
  && echo "   ok" || { echo "   FEHLGESCHLAGEN"; exit 1; }

echo "== 3. CLI, drei Quellen, Laufzeit messen"
# Die Prozesslaufzeit ist das Mass, nicht die Funktionslaufzeit: unter
# shell_exec zaehlt, wann der Prozess endet (gemessen: Funktion 0,21 s,
# Prozess 3,04 s). Sekundengenau reicht dafuer nicht.
START=$EPOCHREALTIME
"$ZIEL/venv/bin/python" "$ZIEL/cli.py" "$FRAGE" --json > /tmp/websuche-rauchtest.json
CODE=$?
DAUER=$(( EPOCHREALTIME - START ))
printf "   Exit-Code %d, %.2f s\n" $CODE $DAUER
[ $CODE -eq 0 ] || { echo "   FEHLGESCHLAGEN"; exit 1; }
# Harte Grenze, keine Warnung: eine gerissene Deadline heisst unter
# shell_exec abgeschnittene Ausgabe beim Agenten.
if (( DAUER > MAX_SEKUNDEN )); then
  printf "   FEHLGESCHLAGEN: %.2f s ueber der %.0f s-Deadline\n" $DAUER $MAX_SEKUNDEN
  exit 1
fi

# Die Pruefungen laufen ueber den venv-Interpreter: das System-python3 ist
# 3.9 und hat die Abhaengigkeiten des Dienstes nicht.
MINDEST_QUELLEN=$MINDEST_QUELLEN "$ZIEL/venv/bin/python" - <<'PY'
import json, os, sys

mindest = int(os.environ["MINDEST_QUELLEN"])
d = json.load(open("/tmp/websuche-rauchtest.json"))
quellen = d["quellen"]
domains = [q["domain"] for q in quellen]
mit_text = [q for q in quellen if q.get("text")]
print(f"   Domains: {domains}")
print(f"   Quellen: {len(quellen)}, davon mit Text: {len(mit_text)}")
print(f"   Hinweis: {d['hinweis']}")

fehler = []
# Ohne diese beiden Zeilen sind alle folgenden Zusicherungen auf einer LEEREN
# Liste wahr (len(set([])) == len([]), all([])) — ein Lauf mit null Quellen
# meldete "bestanden".
if len(quellen) < mindest:
    fehler.append(f"nur {len(quellen)} Quellen, mindestens {mindest} erwartet")
if len(mit_text) < mindest:
    fehler.append(f"nur {len(mit_text)} Quellen mit Text, mindestens {mindest} erwartet")
if len(set(domains)) != len(domains):
    fehler.append(f"Domains nicht eindeutig: {domains}")
if not all(q.get("abgerufen_am") for q in quellen):
    fehler.append("Abrufdatum fehlt bei mindestens einer Quelle")
for q in mit_text:
    if not q.get("url", "").startswith(("http://", "https://")):
        fehler.append(f"Quelle ohne zitierfaehige URL: {q.get('url')!r}")
if fehler:
    print("   FEHLGESCHLAGEN: " + "; ".join(fehler), file=sys.stderr)
    sys.exit(1)
PY
CODE=$?
[ $CODE -eq 0 ] || { echo "   FEHLGESCHLAGEN: Quellen-Pruefung (Exit-Code $CODE)"; exit 1; }

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

if ! searxng_wiederherstellen; then
  trap - EXIT
  echo "FEHLGESCHLAGEN: SearXNG nach dem Rauchtest nicht wiederhergestellt — Suchdienst bleibt abgeschaltet, von Hand pruefen!"
  exit 1
fi
trap - EXIT

echo "Rauchtest bestanden."
