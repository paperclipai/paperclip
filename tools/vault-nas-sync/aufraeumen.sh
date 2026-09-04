#!/usr/bin/env bash
# Aufbewahrung im Auffangordner `_vault-geloescht/`.
#
# Usage: aufraeumen.sh <verzeichnis> [taeglich] [woechentlich] [monatlich]
#
# Warum es das gibt: `vault-nas-sync.sh` schiebt alles, was im Vault geloescht
# oder ersetzt wurde, in `_vault-geloescht/<datum>/`. Das ist der Grund, warum
# der Spiegel ueberhaupt ein Backup ist — aber bis zum 04.09.2026 hat es diese
# Ordner NIE jemand geraeumt: 15 Tagesstaende, 1,1 GB, seit dem 22.08.2026
# monoton wachsend. Ohne Grenze laeuft die NAS irgendwann voll, und dann faellt
# nicht der Auffangordner aus, sondern der Spiegel selbst.
#
# Bewusst als eigenes Skript, aus demselben Grund wie `prune.sh` beim
# Datenbank-Backup: das hier ist der einzige Teil des Spiegels, der LOESCHT,
# und er loescht ausgerechnet das, wovon es sonst keine Kopie mehr gibt --
# eine im Vault entfernte Notiz liegt genau hier und nirgends sonst auf der
# NAS. Getrennt ist er gegen echte Ordner testbar (test_aufraeumen.py).
#
# Schema 7/4/3 (Grossvater-Vater-Sohn), abgestimmt am 04.09.2026:
#   taeglich     die N juengsten Tagesstaende
#   woechentlich je ISO-Woche der juengste Stand, fuer die W juengsten Wochen
#   monatlich    je Kalendermonat der juengste Stand, fuer die M juengsten
#
# Die Stufen UEBERLAGERN sich, sie addieren sich nicht: ein Stand, den schon
# die Tagesstufe haelt, verbraucht keinen Wochenplatz. Das ist die Semantik von
# `restic forget`, und die Auswaerts-Sicherung nach Hetzner rechnet genauso --
# zwei verschiedene Bedeutungen von "7/4/3" im selben System waeren eine Falle.
#
# Die Auswahl richtet sich AUSSCHLIESSLICH nach den vorhandenen Ordnern, nie
# nach der Systemuhr. Lief der Spiegel eine Woche nicht, soll das Aufraeumen
# nicht ploetzlich tiefer greifen als sonst.
set -euo pipefail
shopt -s nullglob

VERZEICHNIS="${1:?Verzeichnis fehlt}"
TAEGLICH="${2:-7}"
WOECHENTLICH="${3:-4}"
MONATLICH="${4:-3}"

if [ ! -d "$VERZEICHNIS" ]; then
  echo "FEHLER: Verzeichnis nicht gefunden: $VERZEICHNIS" >&2
  exit 1
fi

# Schutzriegel gegen die leere Konfiguration. 0/0/0 ist mit Sicherheit ein
# Versehen -- und ein Aufraeumer, der es befolgt, raeumt den gesamten
# Auffangordner leer. Lieber nichts tun und meckern.
if [ "$TAEGLICH" -eq 0 ] && [ "$WOECHENTLICH" -eq 0 ] && [ "$MONATLICH" -eq 0 ]; then
  echo "FEHLER: 7/4/3 alle auf 0 — das wuerde den ganzen Auffangordner raeumen." >&2
  exit 2
fi

# Angefasst wird ausschliesslich das exakte Muster `YYYY-MM-DD`. Alles andere
# bleibt unberuehrt: im echten Auffangordner liegt `2026-08-22-erstlauf`, ein
# Sonderstand aus der Einrichtung, und dort koennen auch fremde Ablagen liegen.
DATEN=()
for p in "$VERZEICHNIS"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]; do
  [ -d "$p" ] && DATEN+=("$(basename "$p")")
done

if [ ${#DATEN[@]} -eq 0 ]; then
  exit 0
fi

IFS=$'\n' SORTIERT=($(printf '%s\n' "${DATEN[@]}" | sort -r)) ; unset IFS

BEHALTEN=()
ist_behalten() {
  local gesucht="$1" d
  for d in ${BEHALTEN[@]+"${BEHALTEN[@]}"}; do
    [ "$d" = "$gesucht" ] && return 0
  done
  return 1
}

# --- 1. Die juengsten Tagesstaende ----------------------------------------
i=0
for d in "${SORTIERT[@]}"; do
  [ "$i" -ge "$TAEGLICH" ] && break
  BEHALTEN+=("$d")
  i=$((i + 1))
done

# --- 2. Je ISO-Woche der juengste Stand ------------------------------------
# `SORTIERT` laeuft absteigend, also ist der erste Treffer einer Woche
# automatisch ihr juengster. `%G-%V` ist das ISO-Wochenpaar; `%Y-%W` waere
# falsch, weil es zum Jahreswechsel eine eigene Woche 00 erfindet.
GESEHENE_WOCHEN=()
kennt_woche() {
  local gesucht="$1" w
  for w in ${GESEHENE_WOCHEN[@]+"${GESEHENE_WOCHEN[@]}"}; do
    [ "$w" = "$gesucht" ] && return 0
  done
  return 1
}
for d in "${SORTIERT[@]}"; do
  [ "${#GESEHENE_WOCHEN[@]}" -ge "$WOECHENTLICH" ] && break
  woche="$(date -j -f "%Y-%m-%d" "$d" "+%G-%V" 2>/dev/null)" || continue
  if ! kennt_woche "$woche"; then
    GESEHENE_WOCHEN+=("$woche")
    ist_behalten "$d" || BEHALTEN+=("$d")
  fi
done

# --- 3. Je Kalendermonat der juengste Stand --------------------------------
GESEHENE_MONATE=()
kennt_monat() {
  local gesucht="$1" m
  for m in ${GESEHENE_MONATE[@]+"${GESEHENE_MONATE[@]}"}; do
    [ "$m" = "$gesucht" ] && return 0
  done
  return 1
}
for d in "${SORTIERT[@]}"; do
  [ "${#GESEHENE_MONATE[@]}" -ge "$MONATLICH" ] && break
  monat="${d%-*}"          # YYYY-MM-DD -> YYYY-MM
  if ! kennt_monat "$monat"; then
    GESEHENE_MONATE+=("$monat")
    ist_behalten "$d" || BEHALTEN+=("$d")
  fi
done

# --- 4. Der Rest geht ------------------------------------------------------
for d in "${SORTIERT[@]}"; do
  if ! ist_behalten "$d"; then
    rm -rf "${VERZEICHNIS:?}/$d"
    echo "geloescht: $d"
  fi
done
