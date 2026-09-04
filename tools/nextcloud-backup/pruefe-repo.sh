#!/usr/bin/env bash
# Monatliche Integritaetspruefung des restic-Repos bei Hetzner/Nextcloud.
#
# Usage: pruefe-repo.sh [--kein-versand] [--repo <pfad>] [--anteil <n/t>]
#                       [--nur-struktur]
#
# WICHTIG: Nicht direkt per launchd starten — dieselbe TCC-Falle wie bei der
# Sicherung selbst. Der Einstieg laeuft ueber `run-pruefe-repo.js` unter node.
#
# Warum es das gibt: Bis zum 04.09.2026 hat NIEMAND je geprueft, ob das Repo
# heil ist. Die taegliche Sicherung meldet nur, ob das Schreiben geklappt hat,
# und der Waechter schaut ausschliesslich auf das ALTER der Snapshots. Beides
# bliebe gruen, waehrend das Repo langsam verrottet — bemerkt haette man es
# erst bei der Wiederherstellung, also an dem Tag, an dem es zu spaet ist.
#
# Zwei Stufen, weil sie Verschiedenes koennen:
#
#   `restic check` allein prueft Struktur und Metadaten: Sind alle Baeume und
#   Bloecke, auf die ein Snapshot zeigt, ueberhaupt vorhanden? Das ist schnell
#   (Sekunden), erkennt aber KEINE gekippten Bits — die Daten werden dabei nie
#   gelesen.
#
#   `--read-data-subset` liest die Bloecke wirklich und rechnet ihre
#   Pruefsummen nach. Das ist der einzige Test, der stille Korruption findet,
#   kostet aber Uebertragung: alles auf einmal waeren ueber 12 GiB durch die
#   Leitung.
#
# Deshalb ein ROTIERENDES ZWOELFTEL: `--read-data-subset=<monat>/12`. Jeden
# Monat ein anderer Abschnitt, nach zwoelf Monaten ist das Repo einmal
# vollstaendig gelesen — bei etwa 1 GiB Verkehr pro Lauf statt zwoelf auf
# einmal. Restic teilt dafuer nach dem Namen der Pack-Dateien auf, die
# Abschnitte sind also stabil und ueberschneidungsfrei.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-rclone:hetzner-nc:Backups/MacStudio-WHITESTAG/restic-mac-studio}"
export RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-$HOME/.restic/repo.pass}"
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

RESTIC="${RESTIC_BIN:-/opt/homebrew/bin/restic}"
LOG="$HOME/.paperclip/logs/repo-pruefung.log"
STATUS="$HOME/.paperclip/logs/repo-pruefung-last.json"
LOCK="$HOME/.paperclip/backups/repo-pruefung.lock"

# Die naechtliche Sicherung haelt die Repo-Sperre. Warten statt scheitern —
# derselbe Grund wie in nextcloud-backup.sh.
WARTEN="--retry-lock 30m"

MAILHUB_URL="http://127.0.0.1:5678/webhook/mailhub/send"
MAILHUB_ENV="$HOME/.paperclip/instances/default/secrets/mailhub.env"
VON="cto@whitestag.ai"; AN="ws@whitestag.ai"

# Der Monat waehlt das Zwoelftel: im Januar 1/12, im Dezember 12/12.
# `10#` erzwingt Dezimal — sonst liest bash "08" und "09" als ungueltige
# Oktalzahl und bricht mit einem Syntaxfehler ab. Genau daran waere dieses
# Skript in jedem August und September gestorben.
ANTEIL="$((10#$(date '+%m')))/12"
VERSAND=1; NUR_STRUKTUR=0

while [ $# -gt 0 ]; do
  case "$1" in
    --kein-versand) VERSAND=0; shift ;;
    --repo)         export RESTIC_REPOSITORY="$2"; shift 2 ;;
    --anteil)       ANTEIL="$2"; shift 2 ;;
    --nur-struktur) NUR_STRUKTUR=1; shift ;;
    *) echo "unbekanntes Argument: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$(dirname "$LOG")" "$(dirname "$LOCK")"
ts() { date '+%Y-%m-%d %H:%M:%S'; }
# `PRUEF_STILL` setzt die Testsuite: sonst landen Testlaeufe im echten Log und
# sehen beim Nachsehen wie Vorfaelle aus (dieselbe Falle wie bei vault-nas-sync).
log() {
  if [ -n "${PRUEF_STILL:-}" ]; then echo "$(ts)  $*"; return; fi
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
        schwanz = "".join(fh.readlines()[-25:])
except OSError:
    schwanz = "(Log nicht lesbar)"
betreff = "ALARM: Sicherungs-Repo beschaedigt"
html = (f"<p><b>Die Integritaetspruefung des restic-Repos ist "
        f"fehlgeschlagen.</b></p>"
        f"<p><b>Grund:</b> {grund}</p>"
        f"<pre style='font-size:12px;background:#f1f3f4;padding:8px'>{schwanz}</pre>"
        f"<p style='color:#a50e0e'>Das ist kein Betriebsfehler, sondern ein "
        f"Befund am Backup selbst: die Sicherungen bei Hetzner sind "
        f"moeglicherweise nicht wiederherstellbar. Die Staende auf der NAS "
        f"und auf der SSD sind davon unberuehrt.</p>"
        f"<p style='color:#5f6368;font-size:12px'>Naechster Schritt: "
        f"<code>restic check --read-data</code> von Hand, dann "
        f"<code>restic repair</code>. Nichts loeschen, bevor der Umfang "
        f"des Schadens feststeht.</p>")
daten = json.dumps({"from": von, "to": an, "subject": betreff,
                    "text": betreff + ": " + grund, "html": html}).encode()
req = urllib.request.Request(url, data=daten,
    headers={"Content-Type": "application/json", "X-Mailhub-Secret": secret})
try:
    with urllib.request.urlopen(req, timeout=30) as a:
        print(f"Alarmmail an {an} gesendet (HTTP {a.status}).")
except Exception as exc:
    print("Alarmmail konnte NICHT gesendet werden:", exc)
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

log "===== Start Integritaetspruefung ($RESTIC_REPOSITORY)"
[ -x "$RESTIC" ] || melde_fehler "restic nicht gefunden: $RESTIC"

# --- 1. Struktur -----------------------------------------------------------
log "Pruefe Struktur (check) ..."
if ! AUSGABE="$("$RESTIC" check $WARTEN 2>&1)"; then
  echo "$AUSGABE" >> "$LOG"
  melde_fehler "Strukturpruefung fehlgeschlagen: $(echo "$AUSGABE" | tail -3 | tr '\n' ' ')"
fi
log "Struktur in Ordnung."

# --- 2. Stichprobe der echten Daten ----------------------------------------
if [ "$NUR_STRUKTUR" -eq 0 ]; then
  log "Lese Datenabschnitt $ANTEIL und pruefe die Pruefsummen ..."
  if ! AUSGABE="$("$RESTIC" check --read-data-subset="$ANTEIL" $WARTEN 2>&1)"; then
    echo "$AUSGABE" >> "$LOG"
    melde_fehler "Datenpruefung ($ANTEIL) fehlgeschlagen: $(echo "$AUSGABE" | tail -3 | tr '\n' ' ')"
  fi
  log "Datenabschnitt $ANTEIL in Ordnung."
else
  ANTEIL="uebersprungen"
fi

printf '{"stand":"ok","zeit":"%s","anteil":"%s"}\n' "$(ts)" "$ANTEIL" > "$STATUS"
log "===== Fertig. Repo unversehrt."
