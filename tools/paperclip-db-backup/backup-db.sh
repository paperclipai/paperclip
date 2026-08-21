#!/usr/bin/env bash
# Taegliche Sicherung der Paperclip-Datenbank auf die NAS.
#
# Usage: backup-db.sh [--ziel <verzeichnis>] [--kein-versand]
#
# WICHTIG: Nicht direkt per launchd starten. macOS verweigert einem
# launchd-Job aus zsh/bash den Zugriff auf SMB-Freigaben (TCC, „Operation not
# permitted"), auch wenn der Mount sichtbar ist. Der Einstieg laeuft deshalb
# ueber `run-backup.js` unter /opt/homebrew/bin/node, das die Berechtigung hat
# und sie an Kindprozesse vererbt — dasselbe Muster wie beim Clara-Mirror.
#
# Reihenfolge mit Absicht: erst lokal dumpen, dann pruefen, dann kopieren,
# dann pruefen, und erst ganz zuletzt alte Sicherungen loeschen. Eine kaputte
# Sicherung darf niemals eine heile ersetzen.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Konfiguration ---------------------------------------------------------
PGHOST="127.0.0.1"
PGPORT="54329"
PGUSER="paperclip"
PGDATABASE="paperclip"
export PGPASSWORD="paperclip"   # wie in query.py; die DB lauscht nur auf localhost

PG_DUMP="/opt/homebrew/bin/pg_dump"
PG_DUMPALL="/opt/homebrew/bin/pg_dumpall"
export PG_RESTORE="/opt/homebrew/bin/pg_restore"

ZIEL="/Volumes/WHITESTAG-ARCHIV/Backup Mac Studio M4 Max/paperclip-db"
LOKAL="$HOME/.paperclip/backups/db"
LOG="$HOME/.paperclip/logs/paperclip-db-backup.log"
STATUS="$HOME/.paperclip/logs/paperclip-db-backup-last.json"
LOCK="$HOME/.paperclip/backups/db-backup.lock"

TAEGLICH=30      # juengste Sicherungen, die immer bleiben
MONATLICH=24     # zusaetzlich aufbewahrte Monatserste
LOKAL_BEHALTEN=2 # lokale Kopien fuer eine schnelle Wiederherstellung

MAILHUB_URL="http://127.0.0.1:5678/webhook/mailhub/send"
MAILHUB_ENV="$HOME/.paperclip/instances/default/secrets/mailhub.env"
VON="cto@whitestag.ai"
AN="ws@whitestag.ai"

VERSAND=1
while [ $# -gt 0 ]; do
  case "$1" in
    --ziel) ZIEL="$2"; shift 2 ;;
    --kein-versand) VERSAND=0; shift ;;
    *) echo "unbekanntes Argument: $1" >&2; exit 2 ;;
  esac
done

TAG="$(date '+%Y-%m-%d')"
DUMP_LOKAL="$LOKAL/paperclip-$TAG.dump"
GLOBALS_LOKAL="$LOKAL/paperclip-globals-$TAG.sql"

mkdir -p "$LOKAL" "$(dirname "$LOG")"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "$(ts)  $*" | tee -a "$LOG"; }

# --- Fehlerbehandlung ------------------------------------------------------
# Ein still gescheitertes Backup ist schlimmer als gar keines: man haelt sich
# fuer gesichert. Deshalb geht jeder Abbruch als Mail raus.
melde_fehler() {
  local grund="$1"
  log "ABBRUCH: $grund"
  printf '{"stand":"fehler","tag":"%s","zeit":"%s","grund":"%s"}\n' \
    "$TAG" "$(ts)" "${grund//\"/\'}" > "$STATUS"
  if [ "$VERSAND" -eq 1 ] && [ -f "$MAILHUB_ENV" ]; then
    local secret
    secret="$(grep '^MAILHUB_SECRET=' "$MAILHUB_ENV" | cut -d= -f2- | tr -d '"' | tr -d '\n')"
    if [ -n "$secret" ]; then
      # Ergebnis des Versands mitloggen: ein Alarm, von dem man nicht weiss,
      # ob er ankam, ist keiner.
      /usr/bin/python3 - "$MAILHUB_URL" "$secret" "$VON" "$AN" "$grund" "$LOG" <<'PY' 2>&1 | tee -a "$LOG" || true
import json, sys, urllib.request
url, secret, von, an, grund, logpfad = sys.argv[1:7]
try:
    with open(logpfad, encoding="utf-8", errors="replace") as fh:
        schwanz = "".join(fh.readlines()[-25:])
except OSError:
    schwanz = "(Log nicht lesbar)"
betreff = "FEHLER: Paperclip-DB-Backup"
html = (f"<p>Die naechtliche Sicherung der Paperclip-Datenbank ist "
        f"abgebrochen.</p><p><b>Grund:</b> {grund}</p>"
        f"<pre style='font-size:12px;background:#f1f3f4;padding:8px'>{schwanz}</pre>"
        f"<p style='color:#5f6368;font-size:12px'>Die letzte erfolgreiche "
        f"Sicherung auf der NAS ist unveraendert — es wurde nichts geloescht.</p>")
daten = json.dumps({"from": von, "to": an, "subject": betreff,
                    "text": betreff + ": " + grund, "html": html}).encode()
req = urllib.request.Request(url, data=daten,
    headers={"Content-Type": "application/json", "X-Mailhub-Secret": secret})
try:
    with urllib.request.urlopen(req, timeout=30) as antwort:
        print(f"Fehlermail an {an} gesendet (HTTP {antwort.status}).")
except Exception as exc:
    print("Fehlermail konnte NICHT gesendet werden:", exc)
PY
    fi
  fi
  rm -f "$LOCK"
  exit 1
}

# --- Sperre gegen Ueberlappung --------------------------------------------
if [ -e "$LOCK" ]; then
  ALT="$(cat "$LOCK" 2>/dev/null || echo '?')"
  if kill -0 "$ALT" 2>/dev/null; then
    log "Laeuft bereits (PID $ALT) — Abbruch ohne Fehler."
    exit 0
  fi
  log "Verwaiste Sperre von PID $ALT entfernt."
  rm -f "$LOCK"
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

log "===== Start Paperclip-DB-Backup ($TAG)"

# --- 1. Dump lokal ---------------------------------------------------------
# Lokal und nicht direkt auf die NAS: schneller, und ein SMB-Aussetzer mitten
# im Dump kann so keine halbe Datei im Zielordner hinterlassen.
[ -x "$PG_DUMP" ] || melde_fehler "pg_dump nicht gefunden: $PG_DUMP"
if ! "$PG_DUMP" -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
      -Fc -f "$DUMP_LOKAL" 2>>"$LOG"; then
  melde_fehler "pg_dump fehlgeschlagen"
fi
GROESSE="$(du -h "$DUMP_LOKAL" | cut -f1)"
log "Dump erstellt: $DUMP_LOKAL ($GROESSE)"

# Rollen und Rechte separat — ohne sie laesst sich der Dump zwar lesen,
# aber nicht sauber in eine frische Instanz einspielen.
if ! "$PG_DUMPALL" -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" \
      --globals-only -f "$GLOBALS_LOKAL" 2>>"$LOG"; then
  melde_fehler "pg_dumpall --globals-only fehlgeschlagen"
fi
log "Globals erstellt: $(du -h "$GLOBALS_LOKAL" | cut -f1)"

# --- 2. Lokal pruefen ------------------------------------------------------
if ! bash "$DIR/verifiziere.sh" "$DUMP_LOKAL" 2>>"$LOG"; then
  melde_fehler "frischer Dump ist unbrauchbar — nichts kopiert, nichts geloescht"
fi
log "Dump verifiziert (vollstaendig lesbar)."

# --- 3. Auf die NAS kopieren ----------------------------------------------
if [ ! -d "$(dirname "$ZIEL")" ]; then
  melde_fehler "NAS nicht erreichbar: $(dirname "$ZIEL")"
fi
mkdir -p "$ZIEL" || melde_fehler "Zielordner nicht anlegbar: $ZIEL"

if ! cp "$DUMP_LOKAL" "$ZIEL/paperclip-$TAG.dump.teil" 2>>"$LOG"; then
  rm -f "$ZIEL/paperclip-$TAG.dump.teil"
  melde_fehler "Kopieren auf die NAS fehlgeschlagen"
fi
cp "$GLOBALS_LOKAL" "$ZIEL/paperclip-globals-$TAG.sql" 2>>"$LOG" \
  || melde_fehler "Globals konnten nicht kopiert werden"

# --- 4. Die KOPIE pruefen, nicht das Original -----------------------------
# SMB reisst unter Last ab; eine halb uebertragene Datei sieht im Verzeichnis
# vollstaendig aus. Deshalb wird die Datei am Ziel gelesen, nicht die Quelle.
if ! bash "$DIR/verifiziere.sh" "$ZIEL/paperclip-$TAG.dump.teil" 2>>"$LOG"; then
  rm -f "$ZIEL/paperclip-$TAG.dump.teil"
  melde_fehler "Kopie auf der NAS ist beschaedigt — verworfen, nichts geloescht"
fi

# Erst jetzt den endgueltigen Namen vergeben. Bis hierhin traegt die Datei die
# Endung .teil und wird von der Aufbewahrung nicht als gueltige Sicherung gezaehlt.
mv "$ZIEL/paperclip-$TAG.dump.teil" "$ZIEL/paperclip-$TAG.dump" \
  || melde_fehler "Umbenennen am Ziel fehlgeschlagen"
log "Auf der NAS verifiziert: $ZIEL/paperclip-$TAG.dump"

# --- 5. Aufbewahrung -------------------------------------------------------
# Erst hier, nachdem eine gueltige neue Sicherung nachweislich liegt.
GELOESCHT="$(bash "$DIR/prune.sh" "$ZIEL" "$TAEGLICH" "$MONATLICH" 2>>"$LOG")" \
  || melde_fehler "Aufbewahrung auf der NAS fehlgeschlagen"
if [ -n "$GELOESCHT" ]; then
  log "NAS-Aufbewahrung: $(echo "$GELOESCHT" | tr '\n' ' ')"
else
  log "NAS-Aufbewahrung: nichts zu loeschen."
fi

bash "$DIR/prune.sh" "$LOKAL" "$LOKAL_BEHALTEN" 0 >/dev/null 2>>"$LOG" \
  || log "WARNUNG: lokale Aufbewahrung fehlgeschlagen (NAS ist gesichert)."

# --- 6. Stand festhalten ---------------------------------------------------
ANZAHL="$(find "$ZIEL" -name 'paperclip-*.dump' | wc -l | tr -d ' ')"
printf '{"stand":"ok","tag":"%s","zeit":"%s","groesse":"%s","sicherungen":%s}\n' \
  "$TAG" "$(ts)" "$GROESSE" "$ANZAHL" > "$STATUS"
log "===== Fertig. $ANZAHL Sicherungen auf der NAS."
