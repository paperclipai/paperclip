#!/usr/bin/env bash
# Aufbewahrung der Paperclip-DB-Dumps.
#
# Usage: prune.sh <verzeichnis> <taeglich> <monatlich>
#   taeglich   Anzahl der juengsten Sicherungen, die immer bleiben
#   monatlich  Anzahl der juengsten Monatsersten, die zusaetzlich bleiben
#
# Bewusst als eigenes Skript: das ist der einzige Teil des Backups, der
# LOESCHT, und damit der einzige, dessen Fehler echte Sicherungen vernichtet.
# Getrennt ist er gegen echte Dateien testbar (test_prune.sh).
#
# Angefasst wird ausschliesslich das Namensmuster `paperclip-<datum>.dump`
# samt zugehoeriger `paperclip-globals-<datum>.sql`. Alles andere im Ordner
# bleibt unberuehrt — dort koennen fremde Sicherungen liegen.
set -euo pipefail
shopt -s nullglob

VERZEICHNIS="${1:?Verzeichnis fehlt}"
TAEGLICH="${2:-30}"
MONATLICH="${3:-24}"

if [ ! -d "$VERZEICHNIS" ]; then
  echo "FEHLER: Verzeichnis nicht gefunden: $VERZEICHNIS" >&2
  exit 1
fi

# Alle vorhandenen Sicherungsdaten, juengste zuerst.
DATEN=()
for f in "$VERZEICHNIS"/paperclip-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].dump; do
  name="$(basename "$f")"
  datum="${name#paperclip-}"
  DATEN+=("${datum%.dump}")
done

if [ ${#DATEN[@]} -eq 0 ]; then
  exit 0
fi

IFS=$'\n' SORTIERT=($(printf '%s\n' "${DATEN[@]}" | sort -r)) ; unset IFS

BEHALTEN=()

# 1. Die juengsten `TAEGLICH` Sicherungen.
i=0
for d in "${SORTIERT[@]}"; do
  [ "$i" -ge "$TAEGLICH" ] && break
  BEHALTEN+=("$d")
  i=$((i + 1))
done

# 2. Zusaetzlich die juengsten `MONATLICH` Monatsersten — sonst reicht die
#    Historie nur so weit zurueck wie die taegliche Grenze.
i=0
for d in "${SORTIERT[@]}"; do
  [ "$i" -ge "$MONATLICH" ] && break
  case "$d" in
    *-01)
      BEHALTEN+=("$d")
      i=$((i + 1))
      ;;
  esac
done

ist_behalten() {
  local gesucht="$1" d
  for d in ${BEHALTEN[@]+"${BEHALTEN[@]}"}; do
    [ "$d" = "$gesucht" ] && return 0
  done
  return 1
}

for d in "${SORTIERT[@]}"; do
  if ! ist_behalten "$d"; then
    rm -f "$VERZEICHNIS/paperclip-$d.dump"
    rm -f "$VERZEICHNIS/paperclip-globals-$d.sql"
    echo "geloescht: $d"
  fi
done
