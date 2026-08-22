#!/usr/bin/env python3
"""Wächter über alle Sicherungen: NAS und Hetzner/Nextcloud.

Deckt die Lücke, die eine Fehlermail im Backup-Skript nicht schließen kann:
den Fall, dass ein Job GAR NICHT MEHR läuft. Ein Skript, das nie startet,
schickt auch keine Fehlermeldung.

Überwacht:
  1. Datenbank auf der NAS          (täglich 02:30)  — Grenze 30 h
  2. Datenbank in der Nextcloud     (täglich 05:00)  — Grenze 30 h
  3. Claude-Code-Ordner, Nextcloud  (täglich 05:00)  — Grenze 30 h
  4. Vault-Spiegel auf der NAS      (täglich 04:00)  — Grenze 30 h
  5. Vault in der Nextcloud         (sonntags 03:30) — Grenze 9 Tage
Dazu die Belegung des Nextcloud-Kontos (Warnung ab 80 %).

WICHTIG: Nicht direkt per launchd starten. macOS verweigert einem launchd-Job
aus zsh/bash/python den Zugriff auf SMB-Freigaben und CloudStorage (TCC).
Der Einstieg läuft über `run-waechter.js` unter node.

Usage: waechter.py [--kein-versand] [--heartbeat-erzwingen] [--nas <pfad>]
"""
import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta

import pruefung

NAS = "/Volumes/WHITESTAG-ARCHIV/Backup Mac Studio M4 Max/paperclip-db"
# Der Vault-Spiegel meldet seinen Stand ueber eine Statusdatei. Bewusst nicht
# ueber die mtime des Zielordners: die sieht auch dann frisch aus, wenn der
# Lauf mittendrin abgebrochen ist.
VAULT_SYNC_STATUS = os.path.expanduser(
    "~/.paperclip/logs/vault-nas-sync-last.json")
RESTIC = "/opt/homebrew/bin/restic"
RESTIC_REPO = "rclone:hetzner-nc:Backups/MacStudio-WHITESTAG/restic-mac-studio"
RESTIC_PASS = os.path.expanduser("~/.restic/repo.pass")

# Schlagworte, unter denen die Sicherungen im gemeinsamen Repo liegen.
TAG_VAULT = "obsidian-vault"
TAG_DB = "paperclip-db"
TAG_CODE = "claude-code"

STD = timedelta(hours=1)
TAG = timedelta(days=1)
# 30 h lassen einen verspäteten Lauf durch, schlagen aber an, sobald eine
# Nacht ausfällt. Der Vault läuft nur sonntags, daher 9 Tage.
GRENZE_TAEGLICH = 30 * STD
GRENZE_VAULT = 9 * TAG

# Gebuchter Speicher des Hetzner-Tarifs, VON HAND eingetragen: weder OCS-API
# noch WebDAV verraten ihn — Nextcloud meldet fuer das Konto nur „unbegrenzt"
# (`-3`), was sich auf das Konto bezieht und nicht auf die Platte dahinter.
# Stand 21.08.2026 laut Walter „ich meine 3 TB"; bei Gelegenheit in der
# Hetzner-Verwaltung nachsehen und hier berichtigen.
# Auf None setzen, um die Platzpruefung abzuschalten.
KONTINGENT_GB = 3000
PLATZ_SCHWELLE = 0.8   # ab hier wird gewarnt
RCLONE = "/opt/homebrew/bin/rclone"
RCLONE_REMOTE = "hetzner-nc:"

LOG = os.path.expanduser("~/.paperclip/logs/backup-waechter.log")
STATUS = os.path.expanduser("~/.paperclip/logs/backup-waechter-last.json")

MAILHUB_URL = "http://127.0.0.1:5678/webhook/mailhub/send"
MAILHUB_ENV = os.path.expanduser(
    "~/.paperclip/instances/default/secrets/mailhub.env")
VON = "cto@whitestag.ai"
AN = "ws@whitestag.ai"


def log(text):
    """Ins Produktivlog schreiben — ausser unter Test.

    `WAECHTER_STILL` setzt die Testsuite (conftest.py). Ohne diese Bremse
    landeten Testlaeufe im echten Log: am 22.08.2026 standen dort Zeilen wie
    „NAS nicht lesbar: /private/var/folders/.../pytest-...". Wer spaeter einen
    Ausfall untersucht, haelt so etwas fuer einen echten Vorfall — das Log ist
    Diagnosewerkzeug und muss sauber bleiben.
    """
    zeile = f"{datetime.now():%Y-%m-%d %H:%M:%S}  {text}"
    if os.environ.get("WAECHTER_STILL"):
        return
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


def status_stand(pfad):
    """Zeitpunkt des letzten ERFOLGREICHEN Laufs aus einer Statusdatei.

    None, wenn die Datei fehlt, unlesbar ist ODER der letzte Lauf
    fehlgeschlagen ist. Ein gescheiterter Lauf darf nicht als frische
    Sicherung durchgehen, nur weil sein Zeitstempel jung ist — das waere
    genau die Sorte stiller Fehlmeldung, gegen die dieser Waechter existiert.
    """
    try:
        with open(pfad, encoding="utf-8") as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        return None
    if d.get("stand") != "ok":
        return None
    try:
        return datetime.fromisoformat(d["zeit"].replace(" ", "T"))
    except (KeyError, ValueError):
        return None


def snapshots():
    """Alle restic-Snapshots, oder None wenn das Repo nicht abfragbar ist.

    ALLE holen, nicht `--latest 1`: das liefert den jüngsten pro Gruppe
    (Host+Pfad). Die Auswahl je Schlagwort trifft `pruefung`.
    """
    umgebung = dict(os.environ)
    umgebung["RESTIC_REPOSITORY"] = RESTIC_REPO
    umgebung["RESTIC_PASSWORD_FILE"] = RESTIC_PASS
    umgebung["PATH"] = "/opt/homebrew/bin:/usr/bin:/bin"
    try:
        r = subprocess.run([RESTIC, "snapshots", "--json"],
                           capture_output=True, text=True, env=umgebung,
                           timeout=600)
    except (OSError, subprocess.TimeoutExpired) as exc:
        log(f"restic nicht abfragbar: {exc}")
        return None
    if r.returncode != 0:
        log(f"restic rc={r.returncode}: {r.stderr.strip()[:200]}")
        return None
    try:
        return json.loads(r.stdout)
    except ValueError as exc:
        log(f"restic-Ausgabe unlesbar: {exc}")
        return None


def belegung():
    """Belegte Bytes des Nextcloud-Kontos, oder None.

    `rclone about` liefert genau die Zahl, die gegen den Tarif zaehlt — die
    Belegung des ganzen Kontos, nicht nur des restic-Repos. Nebenablagen wie
    Documents/ und Photos/ wuerden sonst fehlen.
    """
    try:
        r = subprocess.run([RCLONE, "about", RCLONE_REMOTE, "--json"],
                           capture_output=True, text=True, timeout=300)
    except (OSError, subprocess.TimeoutExpired) as exc:
        log(f"rclone nicht abfragbar: {exc}")
        return None
    if r.returncode != 0:
        log(f"rclone rc={r.returncode}: {r.stderr.strip()[:200]}")
        return None
    try:
        return json.loads(r.stdout).get("used")
    except ValueError as exc:
        log(f"rclone-Ausgabe unlesbar: {exc}")
        return None


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
    ordner = None
    if "--nas" in sys.argv:
        ordner = sys.argv[sys.argv.index("--nas") + 1]
    jetzt = datetime.now()

    stand_nas, anzahl = db_stand(ordner)
    snaps = snapshots()

    def aus_repo(tag):
        """None, wenn das Repo gar nicht abfragbar war — nicht etwa 'kein
        Snapshot vorhanden'. Beides führt zum Alarm, aber die Meldung soll
        stimmen."""
        return None if snaps is None else pruefung.neuester_snapshot(snaps, tag)

    prueflinge = [
        pruefung.Pruefling("Datenbank (NAS)", stand_nas,
                           GRENZE_TAEGLICH, "NAS"),
        pruefung.Pruefling("Datenbank (Nextcloud)", aus_repo(TAG_DB),
                           GRENZE_TAEGLICH, "restic"),
        pruefung.Pruefling("Claude-Code-Ordner (Nextcloud)", aus_repo(TAG_CODE),
                           GRENZE_TAEGLICH, "restic"),
        pruefung.Pruefling("Vault-Spiegel (NAS)",
                           status_stand(VAULT_SYNC_STATUS),
                           GRENZE_TAEGLICH, "Statusdatei"),
        pruefung.Pruefling("Vault (Nextcloud)", aus_repo(TAG_VAULT),
                           GRENZE_VAULT, "restic"),
    ]
    befund = pruefung.bewerte(jetzt, prueflinge)

    # Platzwarnung als zusaetzliche Zeile und ggf. zusaetzliches Problem.
    kontingent = KONTINGENT_GB * 1024 ** 3 if KONTINGENT_GB else None
    platz_problem, platz_zeile = pruefung.bewerte_platz(
        belegung(), kontingent, PLATZ_SCHWELLE)
    befund = pruefung.Befund(
        ok=befund.ok and platz_problem is None,
        probleme=befund.probleme + ([platz_problem] if platz_problem else []),
        zeilen=befund.zeilen + [platz_zeile],
    )

    for zeile in befund.zeilen:
        log(zeile)

    with open(STATUS, "w", encoding="utf-8") as fh:
        json.dump({"stand": "ok" if befund.ok else "problem",
                   "zeit": jetzt.isoformat(timespec="seconds"),
                   "probleme": befund.probleme,
                   "sicherungen_nas": anzahl}, fh, ensure_ascii=False)

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
