#!/usr/bin/env python3
"""Groesse der Paperclip-Logdateien deckeln.

Vorfall 22.08.: ~/.paperclip/instances/default/logs/ war auf ~7 GB gewachsen
(server.log allein 3,0 GB, launchd-paperclip.out.log 371 MB) -- fuer keine
dieser Dateien war je eine Rotation eingerichtet.

WICHTIG -- warum in place gekuerzt und nicht umbenannt wird:
Die grossen Schreiber halten ihre Datei dauerhaft offen (launchd ueber
StandardOutPath/StandardErrorPath, der Server ueber pinos SonicBoom). Ein
os.replace() waere fuer sie unsichtbar: sie schrieben in die umbenannte Datei
weiter, und das "neue" Log bliebe bis zum naechsten Neustart leer. Beide
oeffnen im Anhaengemodus (O_APPEND), deshalb ist os.truncate(path, 0) sauber:
der Kernel setzt den Schreib-Offset selbst auf das Dateiende, es entsteht kein
Loch und die Datei waechst nicht auf ihre alte Groesse zurueck.

Vom juengsten Teil wird eine Generation als <name>.log.1 aufgehoben -- beim
Debuggen ist das Ende interessant, nicht der Anfang.
"""
import os
import sys

# Erst ab hier lohnt das Kuerzen; darunter ist eine Logdatei kein Problem.
DEFAULT_MAX_BYTES = 64 * 1024 * 1024
# So viel vom juengsten Teil bleibt als .1 erhalten.
DEFAULT_KEEP_BYTES = 16 * 1024 * 1024

LOG_DIRS = [
    os.path.expanduser("~/.paperclip/instances/default/logs"),
    os.path.expanduser("~/.paperclip/instances/default/state"),
]


def rotate(path, max_bytes=DEFAULT_MAX_BYTES, keep_bytes=DEFAULT_KEEP_BYTES):
    """-> True, wenn gekuerzt wurde."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return False
    if size <= max_bytes:
        return False

    with open(path, "rb") as f:
        f.seek(max(0, size - keep_bytes))
        rest = f.read(keep_bytes)
    tmp = path + ".1.neu"
    with open(tmp, "wb") as f:
        f.write(rest)
    os.replace(tmp, path + ".1")

    os.truncate(path, 0)
    return True


def rotate_dir(directory, max_bytes=DEFAULT_MAX_BYTES, keep_bytes=DEFAULT_KEEP_BYTES):
    """Alle *.log im Ordner kuerzen. Archive (*.log.1) bleiben aussen vor --
    sonst frisst sich die Rotation durch ihre eigenen Ergebnisse."""
    try:
        namen = sorted(os.listdir(directory))
    except OSError:
        return []
    gekuerzt = []
    for name in namen:
        if not name.endswith(".log"):
            continue
        pfad = os.path.join(directory, name)
        if not os.path.isfile(pfad):
            continue
        if rotate(pfad, max_bytes=max_bytes, keep_bytes=keep_bytes):
            gekuerzt.append(pfad)
    return gekuerzt


def main():
    gekuerzt = []
    for d in LOG_DIRS:
        gekuerzt.extend(rotate_dir(d))
    for pfad in gekuerzt:
        sys.stdout.write("gekuerzt: %s\n" % pfad)
    return 0


if __name__ == "__main__":
    sys.exit(main())
