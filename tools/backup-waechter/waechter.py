#!/usr/bin/env python3
"""Wächter über die Sicherungen: Datenbank (NAS) und Vault (Nextcloud).

Deckt die Lücke, die eine Fehlermail im Backup-Skript nicht schließen kann:
den Fall, dass ein Job GAR NICHT MEHR läuft. Ein Skript, das nie startet,
schickt auch keine Fehlermeldung.

WICHTIG: Nicht direkt per launchd starten. macOS verweigert einem launchd-Job
aus zsh/bash/python den Zugriff auf SMB-Freigaben (TCC). Der Einstieg läuft
über `run-waechter.js` unter node, das die Berechtigung hat und sie an
Kindprozesse vererbt.

Usage: waechter.py [--kein-versand] [--heartbeat-erzwingen]
"""
import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone

import pruefung

NAS = "/Volumes/WHITESTAG-ARCHIV/Backup Mac Studio M4 Max/paperclip-db"
RESTIC = "/opt/homebrew/bin/restic"
RESTIC_REPO = "rclone:hetzner-nc:Backups/MacStudio-WHITESTAG/restic-mac-studio"
RESTIC_PASS = os.path.expanduser("~/.restic/repo.pass")
# Tag, den backup-vault.sh seinen Snapshots gibt — danach wird ausgewaehlt.
VAULT_TAG = "obsidian-vault"
LOG = os.path.expanduser("~/.paperclip/logs/backup-waechter.log")
STATUS = os.path.expanduser("~/.paperclip/logs/backup-waechter-last.json")

MAILHUB_URL = "http://127.0.0.1:5678/webhook/mailhub/send"
MAILHUB_ENV = os.path.expanduser(
    "~/.paperclip/instances/default/secrets/mailhub.env")
VON = "cto@whitestag.ai"
AN = "ws@whitestag.ai"


def log(text):
    zeile = f"{datetime.now():%Y-%m-%d %H:%M:%S}  {text}"
    print(zeile)
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(zeile + "\n")


def db_stand(ordner=None):
    """Zeitpunkt der jüngsten DB-Sicherung auf der NAS, oder None.

    Bewusst die mtime und nicht das Datum im Dateinamen: gefragt ist, wann
    zuletzt tatsächlich geschrieben wurde. Ein Name lässt sich vergeben, ohne
    dass Daten fließen.

    `ordner` ist überschreibbar, damit der Fehlerfall (NAS weg) prüfbar ist,
    ohne die echte Sicherung anzufassen.
    """
    ordner = ordner or NAS
    try:
        dumps = [os.path.join(ordner, n) for n in os.listdir(ordner)
                 if n.startswith("paperclip-") and n.endswith(".dump")]
    except OSError as exc:
        log(f"NAS nicht lesbar: {exc}")
        return None, 0
    if not dumps:
        log("Keine Sicherung im NAS-Ordner gefunden.")
        return None, 0
    juengste = max(dumps, key=os.path.getmtime)
    return datetime.fromtimestamp(os.path.getmtime(juengste)), len(dumps)


def vault_stand():
    """Zeitpunkt des jüngsten restic-Snapshots in der Nextcloud, oder None."""
    umgebung = dict(os.environ)
    umgebung["RESTIC_REPOSITORY"] = RESTIC_REPO
    umgebung["RESTIC_PASSWORD_FILE"] = RESTIC_PASS
    umgebung["PATH"] = "/opt/homebrew/bin:/usr/bin:/bin"
    # ALLE Snapshots holen, nicht `--latest 1`: das liefert den jüngsten
    # PRO GRUPPE (Host+Pfad), und im Repo liegt neben dem Vault-Backup noch
    # ein `setup-test`-Snapshot vom 24.05. Die Auswahl trifft `pruefung`.
    try:
        r = subprocess.run([RESTIC, "snapshots", "--json"],
                           capture_output=True, text=True, env=umgebung,
                           timeout=300)
    except (OSError, subprocess.TimeoutExpired) as exc:
        log(f"restic nicht abfragbar: {exc}")
        return None
    if r.returncode != 0:
        log(f"restic rc={r.returncode}: {r.stderr.strip()[:200]}")
        return None
    try:
        snaps = json.loads(r.stdout)
    except ValueError as exc:
        log(f"restic-Ausgabe unlesbar: {exc}")
        return None
    stand = pruefung.neuester_snapshot(snaps, VAULT_TAG)
    if stand is None:
        log(f"Kein Snapshot mit Tag '{VAULT_TAG}' im Repo "
            f"({len(snaps)} Snapshots insgesamt).")
    return stand


def sende(betreff, html, text):
    try:
        with open(MAILHUB_ENV, encoding="utf-8") as fh:
            secret = next(z.split("=", 1)[1].strip().strip('"')
                          for z in fh if z.startswith("MAILHUB_SECRET="))
    except (OSError, StopIteration) as exc:
        log(f"Mailhub-Secret nicht lesbar: {exc}")
        return False
    daten = json.dumps({"from": VON, "to": AN, "subject": betreff,
                        "text": text, "html": html}).encode("utf-8")
    req = urllib.request.Request(
        MAILHUB_URL, data=daten,
        headers={"Content-Type": "application/json",
                 "X-Mailhub-Secret": secret})
    try:
        with urllib.request.urlopen(req, timeout=30) as antwort:
            log(f"Mail gesendet (HTTP {antwort.status}): {betreff}")
            return True
    except Exception as exc:  # noqa: BLE001
        log(f"Mail konnte NICHT gesendet werden: {exc}")
        return False


def baue_html(befund, anzahl, alarm):
    farbe, kopf = ("#d93025", "Sicherungen: Problem") if alarm else \
                  ("#188038", "Sicherungen: alles grün")
    liste = "".join(f"<li>{z}</li>" for z in befund.zeilen)
    probleme = ""
    if befund.probleme:
        probleme = ("<p style='background:#fce8e6;border-left:3px solid #d93025;"
                    "padding:8px 12px'><b>Befund:</b><br>" +
                    "<br>".join(befund.probleme) + "</p>")
    return (f"<div style=\"font-family:-apple-system,Segoe UI,Arial,sans-serif;"
            f"color:#202124;max-width:640px\">"
            f"<h2 style='color:{farbe};margin-bottom:4px'>{kopf}</h2>"
            f"{probleme}"
            f"<ul style='font-size:14px;line-height:1.7'>{liste}</ul>"
            f"<p style='font-size:14px'>{anzahl} Sicherungen der Datenbank "
            f"liegen auf der NAS.</p>"
            f"<p style='color:#9aa0a6;font-size:12px'>Wächter "
            f"<code>de.whitestag.backup-waechter</code>, täglich 09:00. "
            f"Die Lebendmeldung kommt montags — bleibt sie aus, ist der "
            f"Wächter selbst tot.</p></div>")


def main():
    versand = "--kein-versand" not in sys.argv
    erzwinge = "--heartbeat-erzwingen" in sys.argv
    # Überschreibbarer Pfad, damit der Alarmfall geprüft werden kann, ohne
    # die echte Sicherung anzufassen.
    ordner = None
    if "--nas" in sys.argv:
        ordner = sys.argv[sys.argv.index("--nas") + 1]
    jetzt = datetime.now()

    stand_db, anzahl = db_stand(ordner)
    stand_vault = vault_stand()
    befund = pruefung.bewerte(jetzt, stand_db, stand_vault)

    for zeile in befund.zeilen:
        log(zeile)

    with open(STATUS, "w", encoding="utf-8") as fh:
        json.dump({"stand": "ok" if befund.ok else "problem",
                   "zeit": jetzt.isoformat(timespec="seconds"),
                   "probleme": befund.probleme,
                   "sicherungen": anzahl}, fh, ensure_ascii=False)

    if not befund.ok:
        log("PROBLEM: " + " | ".join(befund.probleme))
        if versand:
            sende("ALARM: Sicherung überfällig",
                  baue_html(befund, anzahl, alarm=True),
                  "Sicherung überfällig: " + " | ".join(befund.probleme))
        return 1

    log("Alles grün.")
    if versand and (erzwinge or pruefung.heartbeat_faellig(jetzt)):
        sende("Sicherungen: alles grün",
              baue_html(befund, anzahl, alarm=False),
              "Alle Sicherungen aktuell.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
