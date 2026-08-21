#!/usr/bin/env bash
# Prueft, ob eine Datei ein lesbarer Postgres-Dump im custom-Format ist.
#
# Usage: verifiziere.sh <dumpdatei>   -> exit 0 = brauchbar
#
# Warum das ein eigener Schritt ist: ohne diese Pruefung koennte eine leere
# oder abgeschnittene Datei auf die NAS wandern und dort eine heile Sicherung
# ersetzen — der schlimmste denkbare Ausgang eines Backups. Erst wenn dieses
# Skript 0 liefert, darf kopiert und darf die Aufbewahrung loeschen.
#
# Geprueft wird in zwei Stufen, beide ohne Schreibzugriff auf eine Datenbank:
#   1. `--list` — ist es ueberhaupt ein Archiv, und enthaelt es Eintraege?
#   2. `-f /dev/null` — das GANZE Archiv einmal auslesen und entpacken.
#
# Stufe 2 ist nicht optional: das Inhaltsverzeichnis des custom-Formats steht
# am Anfang der Datei, deshalb besteht ein **abgeschnittener** Dump die Pruefung
# per `--list` anstandslos. Erst das vollstaendige Lesen faellt mit
# „konnte nicht aus Eingabedatei lesen: Dateiende" durch. Gemessen kostet das
# beim 349-MB-Dump 1,9 s — kein Grund, sich die Sicherheit zu sparen.
set -uo pipefail

DATEI="${1:?Dumpdatei fehlt}"
PG_RESTORE="${PG_RESTORE:-/opt/homebrew/bin/pg_restore}"

if [ ! -f "$DATEI" ]; then
  echo "FEHLER: Datei nicht gefunden: $DATEI" >&2
  exit 1
fi

if [ ! -s "$DATEI" ]; then
  echo "FEHLER: Datei ist leer: $DATEI" >&2
  exit 1
fi

if [ ! -x "$PG_RESTORE" ]; then
  echo "FEHLER: pg_restore nicht gefunden: $PG_RESTORE" >&2
  exit 1
fi

INHALT="$("$PG_RESTORE" --list "$DATEI" 2>&1)" || {
  echo "FEHLER: pg_restore kann das Archiv nicht lesen:" >&2
  echo "$INHALT" | head -3 >&2
  exit 1
}

# Ein Archiv ohne einen einzigen Eintrag ist formal lesbar, aber wertlos.
#
# Here-String statt `echo | grep -q`: `grep -q` steigt beim ersten Treffer aus,
# echo bekommt SIGPIPE und endet mit 141, und `pipefail` reicht die 141 als
# Ergebnis der Pipeline durch. Die Pruefung schlug dadurch fehl, WEIL sie
# erfolgreich war — und nur bei grossen Archiven, weil echo bei kurzer Ausgabe
# fertig schreibt, bevor grep aussteigt (21.08.2026).
if ! grep -qE "^[0-9]+; " <<< "$INHALT"; then
  echo "FEHLER: Archiv enthaelt keine Eintraege: $DATEI" >&2
  exit 1
fi

# Stufe 2: das ganze Archiv auslesen. Faengt abgeschnittene Dateien, die
# `--list` nicht bemerkt, weil das Inhaltsverzeichnis vorne steht.
FEHLER="$("$PG_RESTORE" -f /dev/null "$DATEI" 2>&1)" || {
  echo "FEHLER: Archiv nicht vollstaendig lesbar (abgeschnitten?):" >&2
  echo "$FEHLER" | head -3 >&2
  exit 1
}

exit 0
