#!/usr/bin/env bash
# Taeglicher Spiegel des Obsidian-Vaults auf die NAS.
#
# Usage: vault-nas-sync.sh [--quelle <pfad>] [--ziel <pfad>] [--kein-versand]
#                          [--probe] [--mindest <n>]
#
# WICHTIG: Nicht direkt per launchd starten. macOS verweigert einem launchd-Job
# aus zsh/bash den Zugriff auf SMB-Freigaben ("Operation not permitted", TCC).
# Der Einstieg laeuft ueber `run-vault-nas-sync.js` unter node.
#
# Warum es das gibt: Der Vault lag als EINZIGE Kopie ausserhalb des Macs in der
# Hetzner-Nextcloud. Die vermeintliche NAS-Spiegelung existierte nicht — unter
# /Volumes/WHITESTAG-ARCHIV/Obsidian/ lag nur ein 212-KB-Torso aus der
# Migration vom Mai. Synology Drive spiegelt ausschliesslich
# ~/Library/CloudStorage/SynologyDrive-Mac/, und ~/Obsidian liegt ausserhalb.
#
# EIN SPIEGEL IST KEIN BACKUP: rsync zieht Loeschungen nach. Deshalb wandert
# alles, was ersetzt oder geloescht wird, in einen DATIERTEN Auffangordner
# (`_geloescht/<datum>/`), statt zu verschwinden. Erst das macht den Spiegel
# gegen Fehlgriffe und Verschluesselung brauchbar.
set -uo pipefail

QUELLE="$HOME/Obsidian/WHITESTAG-Vault"
ZIEL="/Volumes/WHITESTAG-ARCHIV/Obsidian/WHITESTAG-Vault"
LOG="$HOME/.paperclip/logs/vault-nas-sync.log"
# Vollstaendige rsync-Ausgabe. Die Zusammenfassung im LOG nennt nur die
# letzten Zeilen; welche EINZELNEN Dateien scheiterten, steht nur hier. Ohne
# diese Datei ist ein Fehlschlag nicht diagnostizierbar — genau daran hing
# die Fehlersuche am 22.08.2026 fest.
RSYNC_LOG="$HOME/.paperclip/logs/vault-nas-sync-rsync.log"
STATUS="$HOME/.paperclip/logs/vault-nas-sync-last.json"
LOCK="$HOME/.paperclip/backups/vault-nas-sync.lock"

# Schutz gegen den gefaehrlichsten Fall: Quelle nicht eingehaengt oder leer.
# Ein blindes `rsync --delete` wuerde dann das Ziel leerraeumen.
# `--mindest` senkt sie nur fuer Tests; im Betrieb bleibt es bei 100.
MINDEST_DATEIEN=100
PAUSE=20   # Sekunden zwischen zwei Anlaeufen; `--pause` senkt sie fuer Tests

# ECHTES GNU rsync, nicht /usr/bin/rsync. macOS liefert dort openrsync aus
# ("rsync version 2.6.9 compatible"), das `--delete` zusammen mit
# `--backup-dir` STILLSCHWEIGEND ignoriert: kein Fehler, kein Hinweis, es
# passiert einfach nichts. Der Spiegel haette dann nie etwas entfernt und nie
# etwas aufgefangen — aufgefallen waere es erst bei der Wiederherstellung.
RSYNC="${RSYNC_BIN:-/opt/homebrew/bin/rsync}"

MAILHUB_URL="http://127.0.0.1:5678/webhook/mailhub/send"
MAILHUB_ENV="$HOME/.paperclip/instances/default/secrets/mailhub.env"
VON="cto@whitestag.ai"; AN="ws@whitestag.ai"

VERSAND=1; PROBE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --quelle) QUELLE="$2"; shift 2 ;;
    --ziel)   ZIEL="$2"; shift 2 ;;
    --kein-versand) VERSAND=0; shift ;;
    --mindest) MINDEST_DATEIEN="$2"; shift 2 ;;
    --pause)   PAUSE="$2"; shift 2 ;;   # nur fuer Tests
    --probe)  PROBE=1; shift ;;
    *) echo "unbekanntes Argument: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$(dirname "$LOG")" "$(dirname "$LOCK")"
ts() { date '+%Y-%m-%d %H:%M:%S'; }
# `SYNC_STILL` setzt die Testsuite (conftest.py): sonst landen Testlaeufe im
# echten Log und sehen beim Nachsehen wie Vorfaelle aus.
log() {
  if [ -n "${SYNC_STILL:-}" ]; then echo "$(ts)  $*"; return; fi
  echo "$(ts)  $*" | tee -a "$LOG"
}

melde_fehler() {
  local grund="$1"
  log "ABBRUCH: $grund"
  printf '{"stand":"fehler","zeit":"%s","grund":"%s"}\n' \
    "$(ts)" "${grund//\"/\'}" > "$STATUS"
  if [ "$VERSAND" -eq 1 ] && [ -f "$MAILHUB_ENV" ]; then
    local secret
    secret="$(grep '^MAILHUB_SECRET=' "$MAILHUB_ENV" | cut -d= -f2- | tr -d '"' | tr -d '\n')"
    if [ -n "$secret" ]; then
      /usr/bin/python3 - "$MAILHUB_URL" "$secret" "$VON" "$AN" "$grund" "$LOG" <<'PY' 2>&1 | tee -a "$LOG" || true
import json, sys, urllib.request
url, secret, von, an, grund, logpfad = sys.argv[1:7]
try:
    with open(logpfad, encoding="utf-8", errors="replace") as fh:
        schwanz = "".join(fh.readlines()[-20:])
except OSError:
    schwanz = "(Log nicht lesbar)"
betreff = "FEHLER: Vault-Spiegel auf die NAS"
html = (f"<p>Der taegliche Vault-Spiegel auf die NAS ist abgebrochen.</p>"
        f"<p><b>Grund:</b> {grund}</p>"
        f"<pre style='font-size:12px;background:#f1f3f4;padding:8px'>{schwanz}</pre>"
        f"<p style='color:#5f6368;font-size:12px'>Der vorhandene Stand auf der "
        f"NAS ist unveraendert — es wurde nichts geloescht.</p>")
daten = json.dumps({"from": von, "to": an, "subject": betreff,
                    "text": betreff + ": " + grund, "html": html}).encode()
req = urllib.request.Request(url, data=daten,
    headers={"Content-Type": "application/json", "X-Mailhub-Secret": secret})
try:
    with urllib.request.urlopen(req, timeout=30) as a:
        print(f"Fehlermail an {an} gesendet (HTTP {a.status}).")
except Exception as exc:
    print("Fehlermail konnte NICHT gesendet werden:", exc)
PY
    fi
  fi
  rm -f "$LOCK"
  exit 1
}

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

log "===== Start Vault-Spiegel"

# --- Sicherungen VOR dem Schreiben ----------------------------------------
[ -x "$RSYNC" ] || melde_fehler "rsync nicht gefunden: $RSYNC"
RSYNC_VER="$("$RSYNC" --version 2>&1 | head -1)"
case "$RSYNC_VER" in
  *openrsync*) melde_fehler "openrsync gefunden ($RSYNC) — ignoriert --backup-dir stillschweigend. Echtes GNU rsync noetig." ;;
esac
HAUPT="$(printf '%s' "$RSYNC_VER" | sed -nE 's/.*version ([0-9]+)\..*/\1/p')"
if [ -z "$HAUPT" ] || [ "$HAUPT" -lt 3 ]; then
  melde_fehler "rsync zu alt oder unbekannt: $RSYNC_VER (mindestens GNU rsync 3 noetig)"
fi
log "rsync: $RSYNC_VER"
[ -d "$QUELLE" ] || melde_fehler "Quelle nicht vorhanden: $QUELLE"
ANZAHL="$(find "$QUELLE" -type f 2>/dev/null | head -$((MINDEST_DATEIEN + 1)) | wc -l | tr -d ' ')"
if [ "$ANZAHL" -le "$MINDEST_DATEIEN" ]; then
  melde_fehler "Quelle verdaechtig leer ($ANZAHL Dateien, erwartet > $MINDEST_DATEIEN) — nichts angefasst"
fi
[ -d "$(dirname "$ZIEL")" ] || melde_fehler "NAS nicht erreichbar: $(dirname "$ZIEL")"
mkdir -p "$ZIEL" || melde_fehler "Zielordner nicht anlegbar: $ZIEL"

# NEBEN dem Spiegel, nicht darin. Ein Auffangordner innerhalb des Zielbaums
# bringt `--delete` und `--backup-dir` durcheinander: am 22.08.2026 gab es
# dadurch 4.465 Fehler der Form `mkstemp ... No such file or directory`, weil
# rsync Verzeichnisse entfernte, in die es unmittelbar danach schreiben
# wollte. rsync empfiehlt einen Pfad ausserhalb des Ziels ausdruecklich.
AUFFANG="$(dirname "$ZIEL")/_vault-geloescht/$(date '+%Y-%m-%d')"

# --exclude: Arbeitsdateien von Obsidian, die sich staendig aendern und nichts
# zur Wiederherstellung beitragen. `.obsidian/` selbst BLEIBT (Einstellungen,
# Plugins) — nur die Sitzungsdateien fliegen raus.
RSYNC_ARGS=(
  -a --delete
  --backup
  # --checksum vergleicht den INHALT statt Groesse und Zeit. Ohne das
  # konvergiert der Spiegel nie: die SMB-Freigabe verwirft rsyncs Zeitstempel
  # beim Schliessen der Datei (`touch` danach geht, rsyncs eigener Versuch
  # nicht) und erzwingt Modus 700 statt 644. rsync hielt deshalb bei JEDEM
  # Lauf alle Dateien fuer veraendert — am 22.08.2026 gemessen: 7.040
  # uebertragen und 46.983 in den Auffangordner geschoben, auf einem bereits
  # vollstaendigen Stand.
  #
  # Kosten: rsync liest beide Seiten. Nutzen: identische Dateien werden nicht
  # uebertragen und landen damit auch nicht im Auffangordner, waehrend eine
  # echte Inhaltsaenderung weiterhin sicher erkannt wird.
  --checksum
  # Die Freigabe nimmt Rechte und Eigentuemer ohnehin nicht an; der Versuch
  # erzeugt nur Rauschen und laesst jede Datei als veraendert erscheinen.
  --no-perms --no-owner --no-group
  --exclude ".DS_Store"
  --exclude "._*"
  --exclude ".trash/"
  --exclude ".obsidian/workspace*.json"
  --exclude ".obsidian/cache/"
  --exclude "_geloescht/"
  --exclude ".rsync-partial/"
  # Wiederherstellbarer Ballast aus den Code-Projekten im Vault: 2 `.venv`
  # (0,7 GB, 8.097 Dateien, darunter ein 572-MB-spaCy-Modell), 433
  # `__pycache__`, dazu `node_modules` — zusammen ein Viertel aller Dateien.
  # Genau daran scheiterte `projekte/obsidian` am 22.08.2026 wieder und
  # wieder, und alles davon entsteht aus den Lockfiles neu.
  # `.git` bleibt ausdruecklich DRIN: dort steckt Historie, und die Projekte
  # im Vault haben nicht zwangslaeufig ein Remote.
  --exclude ".venv/"
  --exclude "venv/"
  --exclude "node_modules/"
  --exclude "__pycache__/"
  --exclude "*.pyc"
  # --partial-dir statt blossem --partial: `--partial` laesst Bruchstuecke AM
  # ZIELORT liegen. Der naechste Versuch haelt sie fuer echten Inhalt, schiebt
  # sie in den Auffangordner und uebertraegt neu — nach drei Fehlversuchen
  # standen so 7.900 Bruchstuecke (455 MB) in `_geloescht/`, und der
  # Auffangordner war als Diagnosewerkzeug wertlos. Im versteckten
  # `.rsync-partial/` stoeren sie niemanden und werden beim naechsten Lauf
  # sauber weiterverwendet.
  --partial-dir=.rsync-partial
  --stats
)
[ "$PROBE" -eq 1 ] && RSYNC_ARGS+=(--dry-run)

log "Spiegle $QUELLE ($ANZAHL+ Dateien) -> $ZIEL"

# ORDNERWEISE, nicht in einem Rutsch. Der entscheidende Befund vom
# 22.08.2026: bei 47.568 Dateien am Stueck reisst SMB zuverlaessig ab —
# gemessen 650 Schreibfehler ("mkstemp ... Operation timed out") je Anlauf,
# und drei Anlaeufe hintereinander scheiterten. Dieselbe Datenmenge
# ordnerweise uebertragen: 54 Ordner, NULL Fehler.
#
# Preis dieser Bauweise: `--delete` wirkt innerhalb jedes Ordners, aber ein
# im Vault komplett geloeschter Ordner der obersten Ebene bleibt auf der NAS
# stehen. Das ist die sichere Richtung — es bleibt zu viel erhalten, nie zu
# wenig. Festgehalten in test_sync.py.
VERSUCHE=3
UEBERTRAGEN=0
GELOESCHT=0
FEHLER_ORDNER=""

shopt -s dotglob nullglob
cd "$QUELLE" || melde_fehler "Quelle nicht betretbar: $QUELLE"

# Dateien der obersten Ebene in EINEM Aufruf, Verzeichnisse einzeln.
# `--delete` auf eine einzelne Datei quittiert rsync mit einem Syntaxfehler
# (code 1) — deshalb `--exclude '/*/'`, das alle Unterordner ausblendet und
# nur die losen Dateien im Wurzelverzeichnis behandelt.
EINTRAEGE=("::wurzeldateien::")
for E in *; do
  case "$E" in .|..|_geloescht|.rsync-partial|.trash) continue ;; esac
  [ -d "$E" ] && EINTRAEGE+=("$E")
done

for E in "${EINTRAEGE[@]}"; do
  if [ "$E" = "::wurzeldateien::" ]; then
    QUELL_ARG="$QUELLE/"
    ZUSATZ=(--exclude "/*/" --backup-dir="$AUFFANG/_wurzel")
  else
    QUELL_ARG="$QUELLE/$E"
    ZUSATZ=(--backup-dir="$AUFFANG/$E")
  fi
  n=1
  while : ; do
    AUSGABE="$("$RSYNC" "${RSYNC_ARGS[@]}" "${ZUSATZ[@]}" \
                "$QUELL_ARG" "$ZIEL/" 2>&1)"
    RC=$?
    { echo "===== $(ts) [$E] Versuch $n (rc=$RC)"; echo "$AUSGABE"; } >> "$RSYNC_LOG"
    if [ "$RC" -eq 0 ]; then
      U="$(echo "$AUSGABE" | grep -E "^Number of regular files transferred" | grep -oE "[0-9,]+$" | tr -d ',')"
      G="$(echo "$AUSGABE" | grep -E "^Number of deleted files" | grep -oE "[0-9,]+$" | tr -d ',')"
      UEBERTRAGEN=$((UEBERTRAGEN + ${U:-0}))
      GELOESCHT=$((GELOESCHT + ${G:-0}))
      break
    fi
    if [ "$n" -ge "$VERSUCHE" ]; then
      log "  $E: nach $VERSUCHE Versuchen fehlgeschlagen — $(echo "$AUSGABE" | tail -1)"
      # Feiner aufteilen statt aufgeben. Am 22.08.2026 scheiterten `Katalog`
      # (9.135 winzige Dateien) und `projekte` (9.322 Dateien, eine davon
      # 572 MB) auch ordnerweise — dieselbe SMB-Ueberlastung wie beim
      # monolithischen Lauf, nur eine Ebene tiefer. Kleinere Haeppchen haben
      # bisher jedes Mal geholfen, also wird genau das getan.
      if [ "$E" != "::wurzeldateien::" ] && [ -d "$QUELLE/$E" ]; then
        UNTER=0
        for U2 in "$QUELLE/$E"/*/; do
          [ -d "$U2" ] || continue
          UNTER=1
          NAME="$(basename "$U2")"
          for m in 1 2 3; do
            AUS2="$("$RSYNC" "${RSYNC_ARGS[@]}" \
                     --backup-dir="$AUFFANG/$E/$NAME" \
                     "$QUELLE/$E/$NAME" "$ZIEL/$E/" 2>&1)"
            RC2=$?
            { echo "===== $(ts) [$E/$NAME] Versuch $m (rc=$RC2)"; echo "$AUS2"; } >> "$RSYNC_LOG"
            [ "$RC2" -eq 0 ] && break
            [ "$m" -ge 3 ] && { FEHLER_ORDNER="$FEHLER_ORDNER $E/$NAME"; log "    $E/$NAME: endgueltig fehlgeschlagen"; }
            sleep "$PAUSE"
          done
        done
        # Die losen Dateien des Ordners noch hinterher.
        "$RSYNC" "${RSYNC_ARGS[@]}" --exclude "/*/" \
          --backup-dir="$AUFFANG/$E/_dateien" \
          "$QUELLE/$E/" "$ZIEL/$E/" >>"$RSYNC_LOG" 2>&1 \
          || FEHLER_ORDNER="$FEHLER_ORDNER $E/(Dateien)"
        [ "$UNTER" -eq 1 ] && log "  $E: in Unterordner zerlegt und einzeln uebertragen."
      else
        FEHLER_ORDNER="$FEHLER_ORDNER $E"
      fi
      break
    fi
    sleep "$PAUSE"
    n=$((n + 1))
  done
done

# Erst wenn ein Ordner endgueltig scheitert, ist der Lauf gescheitert. Ein
# einzelner Aussetzer soll nicht die ganze Nacht ungenutzt lassen.
if [ -n "$FEHLER_ORDNER" ]; then
  melde_fehler "Ordner nicht gespiegelt:$FEHLER_ORDNER (Details in $RSYNC_LOG)"
fi

log "Uebertragen: $UEBERTRAGEN, entfernt: $GELOESCHT"
if [ -d "$AUFFANG" ]; then
  log "Aufgefangen in $AUFFANG: $(find "$AUFFANG" -type f | wc -l | tr -d ' ') Dateien"
fi

printf '{"stand":"ok","zeit":"%s","uebertragen":%s,"entfernt":%s}\n' \
  "$(ts)" "${UEBERTRAGEN:-0}" "${GELOESCHT:-0}" > "$STATUS"
log "===== Fertig."
