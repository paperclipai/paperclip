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
  6. SSD-Sicherung, lokal           (täglich 03:30)  — Grenze 30 h
  7. Systemgeheimnisse, Nextcloud   (täglich 05:45)  — Grenze 30 h
  8. NAS-Projektordner, Nextcloud   (täglich 06:15)  — Grenze 30 h
  9. n8n, Nextcloud                 (täglich 05:45)  — Grenze 30 h
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
# Monatliche Integritaetspruefung des restic-Repos (de.whitestag.repo-pruefung).
# Ohne diese Zeile im Waechter waere die Pruefung selbst unbewacht: faellt sie
# aus, wuerde niemand das Repo mehr auf Korruption ansehen — und das faellt
# erst bei der Wiederherstellung auf.
REPO_PRUEF_STATUS = os.path.expanduser(
    "~/.paperclip/logs/repo-pruefung-last.json")
# Synology-Drive-Spiegel von "Claude Code MAC". Kein eigener Dienst von uns —
# der Synology-Client spiegelt fortlaufend. Genau deshalb faellt sein Ausfall
# ohne Pruefung niemandem auf.
SYNOLOGY_SPIEGEL = ("/Volumes/WHITESTAG-ARCHIV/Mac Studio M4 Max 128GB/"
                    "Claude Code MAC")
RESTIC = "/opt/homebrew/bin/restic"
RESTIC_REPO = "rclone:hetzner-nc:Backups/MacStudio-WHITESTAG/restic-mac-studio"
RESTIC_PASS = os.path.expanduser("~/.restic/repo.pass")

# Schlagworte, unter denen die Sicherungen im gemeinsamen Repo liegen.
TAG_VAULT = "obsidian-vault"
TAG_DB = "paperclip-db"
TAG_CODE = "claude-code"
# Seit 04.09.2026: Schluessel, Secrets, .claude und Postgres@18 (Port 5432),
# sowie die Projektordner von Windows-Rechner und MacBook.
TAG_SECRETS = "system-secrets"
TAG_NAS = "nas-projekte"
# n8n mit eigenem Schlagwort: die 2,2-GB-Datenbank aendert sich taeglich
# komplett, ihre Aufbewahrung soll getrennt kuerzbar bleiben.
TAG_N8N = "n8n"

# Lokale Sicherung auf die Thunderbolt-SSD (de.whitestag.ssd-backup).
# Die Statusdatei liegt bewusst lokal und nicht auf der Platte selbst: sonst
# waere der Stand bei abgezogener SSD "nicht ermittelbar" statt "ueberfaellig".
SSD_STATUS = os.path.expanduser("~/.paperclip/logs/ssd-backup-last.json")

STD = timedelta(hours=1)
TAG = timedelta(days=1)
# 30 h lassen einen verspäteten Lauf durch, schlagen aber an, sobald eine
# Nacht ausfällt. Der Vault läuft nur sonntags, daher 9 Tage.
GRENZE_TAEGLICH = 30 * STD
GRENZE_VAULT = 9 * TAG
# Synology-Spiegel grosszuegig: der Ordner darf auch mal ein Wochenende ruhig
# sein. Passiert dort eine Woche lang nichts, stimmt aber etwas nicht.
GRENZE_SYNOLOGY = 7 * TAG
# Die Repo-Pruefung laeuft am 6. jedes Monats. 45 Tage lassen einen langen
# Monat plus einen verspaeteten Nachholtermin durch (der Mac war am 6. aus),
# schlagen aber an, wenn ein Termin ganz ausfaellt. Enger waere ein
# Fehlalarm-Automat, weiter wuerde einen echten Ausfall zu lange decken.
GRENZE_REPO_PRUEFUNG = 45 * TAG

# Gebuchter Speicher des Hetzner-Tarifs, VON HAND eingetragen: weder OCS-API
# noch WebDAV verraten ihn — Nextcloud meldet fuer das Konto nur „unbegrenzt"
# (`-3`), was sich auf das Konto bezieht und nicht auf die Platte dahinter.
# Auch `rclone about hetzner-nc:` liefert nur `used`, keine Gesamtgroesse.
#
# Am 04.09.2026 von Walter BESTAETIGT: 3 TB. Vorher stand hier „ich meine
# 3 TB" mit der Bitte, es nachzusehen — das ist erledigt, die Zahl ist keine
# Vermutung mehr. Aendert sich der Tarif, muss sie hier von Hand nachgezogen
# werden; es gibt keine Stelle, die das bemerken wuerde.
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


def ordner_stand(pfad):
    """Juengster Zeitstempel der OBERSTEN EBENE eines Ordners, oder None.

    Bewusst kein Vollscan: der Spiegel ist 15 GB gross, ein rekursiver
    Durchlauf ueber SMB dauert Minuten und wuerde den Waechter blockieren.
    Synology Drive aktualisiert die Zeitstempel der Elternordner mit — das
    genuegt als Lebenszeichen.
    """
    try:
        eintraege = [os.path.join(pfad, n) for n in os.listdir(pfad)]
    except OSError as exc:
        log(f"Synology-Spiegel nicht lesbar: {exc}")
        return None
    zeiten = []
    for e in eintraege:
        try:
            zeiten.append(os.path.getmtime(e))
        except OSError:
            continue
    if not zeiten:
        log(f"Synology-Spiegel ist leer: {pfad}")
        return None
    return datetime.fromtimestamp(max(zeiten))


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


def vorheriger_stand():
    """Kennzahlen des letzten Laufs, fuer die Zuwachs-Spalte im Bericht.

    Leeres Dict, wenn es keinen Vorlauf gibt — der erste Bericht zeigt dann
    schlicht keinen Zuwachs, statt eine erfundene Zahl auszuweisen.
    """
    try:
        with open(STATUS, encoding="utf-8") as fh:
            return json.load(fh).get("kennzahlen") or {}
    except (OSError, ValueError):
        return {}


def ssd_kennzahlen():
    """Snapshot-Zahl und Belegung der SSD aus deren Statusdatei."""
    try:
        with open(SSD_STATUS, encoding="utf-8") as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        return {}
    return {"ssd_snapshots": d.get("snapshots", 0),
            "ssd_belegt_kb": d.get("belegt_kb", 0),
            "ssd_frei_kb": d.get("frei_kb", 0),
            "ssd_fehlende_quellen": d.get("fehlende_quellen", 0)}


def zaehle_je_tag(snaps, tags):
    """Anzahl Snapshots je Schlagwort. Leeres Dict, wenn das Repo stumm war."""
    if snaps is None:
        return {}
    ergebnis = {}
    for t in tags:
        ergebnis[t] = sum(1 for x in snaps if t in (x.get("tags") or []))
    return ergebnis


def _gb(kb):
    return kb / 1024 / 1024


def _delta_text(jetzt_wert, vorher_wert, einheit="GB"):
    """Zuwachs gegenueber dem Vorlauf, oder leer wenn kein Vergleich moeglich.

    Ein Zuwachs von exakt 0 wird ausgewiesen, nicht verschwiegen: er ist das
    Warnzeichen dafuer, dass ein Job zwar laeuft, aber nichts mehr sichert.
    """
    if vorher_wert is None or jetzt_wert is None:
        return ""
    d = jetzt_wert - vorher_wert
    if einheit == "GB":
        if abs(d) < 0.05:
            return " (unverändert)"
        return f" ({d:+.1f} GB)"
    if d == 0:
        return " (unverändert)"
    return f" ({d:+d})"


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


def baue_bericht(kennzahlen, vorher):
    """Tabelle mit Umfang und Zuwachs. Leerer String, wenn nichts vorliegt."""
    if not kennzahlen:
        return ""

    zeilen = []

    def zeile(name, wert, zuwachs=""):
        zeilen.append(
            f"<tr><td style='padding:3px 12px 3px 0'>{name}</td>"
            f"<td style='padding:3px 0;text-align:right;white-space:nowrap'>"
            f"{wert}<span style='color:#5f6368'>{zuwachs}</span></td></tr>")

    for schluessel, name in (("claude-code", "Claude-Code-Ordner"),
                             ("paperclip-db", "Paperclip-Datenbank"),
                             ("obsidian-vault", "Obsidian-Vault"),
                             ("system-secrets", "Systemgeheimnisse"),
                             ("nas-projekte", "NAS-Projektordner"),
                             ("n8n", "n8n")):
        n = kennzahlen.get("snaps", {}).get(schluessel)
        if n is None:
            continue
        alt = (vorher.get("snaps") or {}).get(schluessel)
        zeile(f"{name} (Hetzner)", f"{n} Snapshots",
              _delta_text(n, alt, "stk"))

    if "ssd_snapshots" in kennzahlen:
        zeile("SSD-Sicherung (lokal)",
              f"{kennzahlen['ssd_snapshots']} Snapshots",
              _delta_text(kennzahlen["ssd_snapshots"],
                          vorher.get("ssd_snapshots"), "stk"))
        belegt = _gb(kennzahlen.get("ssd_belegt_kb", 0))
        alt_belegt = (_gb(vorher["ssd_belegt_kb"])
                      if "ssd_belegt_kb" in vorher else None)
        zeile("&nbsp;&nbsp;belegt", f"{belegt:.1f} GB",
              _delta_text(belegt, alt_belegt))
        zeile("&nbsp;&nbsp;frei", f"{_gb(kennzahlen.get('ssd_frei_kb', 0)):.0f} GB")

    if kennzahlen.get("nc_used_gb") is not None:
        zeile("Hetzner belegt", f"{kennzahlen['nc_used_gb']:.1f} GB",
              _delta_text(kennzahlen["nc_used_gb"], vorher.get("nc_used_gb")))

    return ("<h3 style='font-size:15px;margin:18px 0 6px'>Umfang</h3>"
            "<table style='font-size:14px;border-collapse:collapse'>"
            + "".join(zeilen) + "</table>")


def baue_html(befund, anzahl, alarm, kennzahlen=None, vorher=None):
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
            f"{baue_bericht(kennzahlen or {}, vorher or {})}"
            f"<p style='color:#9aa0a6;font-size:12px'>Wächter "
            f"<code>de.whitestag.backup-waechter</code>, täglich 07:00 — "
            f"nach dem letzten Sicherungslauf (06:15). Der Betreff trägt das "
            f"Ergebnis; bleibt der Bericht ganz aus, ist der Wächter selbst "
            f"tot.</p></div>")


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
        pruefung.Pruefling("Claude-Code-Spiegel (NAS)",
                           ordner_stand(SYNOLOGY_SPIEGEL),
                           GRENZE_SYNOLOGY, "Synology Drive"),
        pruefung.Pruefling("Vault (Nextcloud)", aus_repo(TAG_VAULT),
                           GRENZE_VAULT, "restic"),
        # Nicht das Alter einer Sicherung, sondern das der letzten
        # Unversehrtheitspruefung. Alle anderen Zeilen sagen nur, dass etwas
        # GESCHRIEBEN wurde — diese sagt, dass es sich auch LESEN laesst.
        pruefung.Pruefling("Repo-Pruefung (Hetzner)",
                           status_stand(REPO_PRUEF_STATUS),
                           GRENZE_REPO_PRUEFUNG, "Statusdatei"),
        # Seit 04.09.2026. Die SSD haengt dauerhaft am Mac; faellt der Lauf
        # aus, ist das kein Sonderfall, sondern ein Ausfall wie jeder andere.
        pruefung.Pruefling("SSD-Sicherung (lokal)",
                           status_stand(SSD_STATUS),
                           GRENZE_TAEGLICH, "Statusdatei"),
        pruefung.Pruefling("Systemgeheimnisse (Nextcloud)",
                           aus_repo(TAG_SECRETS),
                           GRENZE_TAEGLICH, "restic"),
        pruefung.Pruefling("NAS-Projektordner (Nextcloud)",
                           aus_repo(TAG_NAS),
                           GRENZE_TAEGLICH, "restic"),
        pruefung.Pruefling("n8n (Nextcloud)", aus_repo(TAG_N8N),
                           GRENZE_TAEGLICH, "restic"),
    ]
    befund = pruefung.bewerte(jetzt, prueflinge)

    # Platzwarnung als zusaetzliche Zeile und ggf. zusaetzliches Problem.
    # `belegung()` fragt rclone ueber das Netz — bewusst nur EIN Aufruf, der
    # sowohl die Warnung als auch die Kennzahl im Bericht speist.
    belegt_bytes = belegung()
    kontingent = KONTINGENT_GB * 1024 ** 3 if KONTINGENT_GB else None
    platz_problem, platz_zeile = pruefung.bewerte_platz(
        belegt_bytes, kontingent, PLATZ_SCHWELLE)
    befund = pruefung.Befund(
        ok=befund.ok and platz_problem is None,
        probleme=befund.probleme + ([platz_problem] if platz_problem else []),
        zeilen=befund.zeilen + [platz_zeile],
    )

    for zeile in befund.zeilen:
        log(zeile)

    # Kennzahlen fuer den Bericht. VOR dem Ueberschreiben des Status lesen,
    # sonst vergleicht der Zuwachs gegen sich selbst.
    vorher = vorheriger_stand()
    kennzahlen = {
        "snaps": zaehle_je_tag(snaps, [TAG_CODE, TAG_DB, TAG_VAULT,
                                       TAG_SECRETS, TAG_NAS, TAG_N8N]),
        "nc_used_gb": (belegt_bytes / 1024 ** 3
                       if belegt_bytes is not None else None),
    }
    kennzahlen.update(ssd_kennzahlen())

    # Ein unvollstaendiger SSD-Snapshot (NAS beim Lauf nicht gemountet) ist
    # kein Grund fuer Alarm — die Sicherung lief ja — aber er gehoert in den
    # Bericht, sonst faellt monatelang niemandem auf, dass Ordner fehlen.
    fehlend = kennzahlen.get("ssd_fehlende_quellen") or 0
    if fehlend:
        befund = pruefung.Befund(
            ok=befund.ok,
            probleme=befund.probleme,
            zeilen=befund.zeilen + [
                f"Hinweis: der letzte SSD-Lauf konnte {fehlend} Quelle(n) "
                f"nicht erreichen (NAS nicht gemountet?)."],
        )

    with open(STATUS, "w", encoding="utf-8") as fh:
        json.dump({"stand": "ok" if befund.ok else "problem",
                   "zeit": jetzt.isoformat(timespec="seconds"),
                   "probleme": befund.probleme,
                   "sicherungen_nas": anzahl,
                   "kennzahlen": kennzahlen}, fh, ensure_ascii=False)

    geprueft = len(prueflinge)

    if not befund.ok:
        log("PROBLEM: " + " | ".join(befund.probleme))
        if versand:
            sende(f"ALARM {jetzt:%d.%m.}: Sicherung überfällig",
                  baue_html(befund, anzahl, alarm=True, kennzahlen=kennzahlen,
                            vorher=vorher),
                  "Sicherung überfällig: " + " | ".join(befund.probleme))
        return 1

    log("Alles grün.")
    # Seit 04.09.2026 taeglich statt montags/donnerstags — auf Walters Wunsch
    # ein Bericht, der zeigt, WAS gesichert wurde, nicht nur DASS.
    #
    # Der Einwand aus pruefung.heartbeat_faellig() bleibt gueltig: eine Mail,
    # die jeden Morgen kommt, wird zur Gewohnheit. Dagegen steht das Ergebnis
    # im Betreff ("8/8 grün"), sodass sich das Postfach ueberfliegen laesst,
    # ohne eine Mail zu oeffnen — und eine fehlende Zeile faellt beim
    # Ueberfliegen auf. `heartbeat_faellig` bleibt unangetastet, damit die
    # Rueckkehr zum alten Rhythmus eine Zeile Arbeit ist.
    if versand:
        sende(f"Sicherungen {jetzt:%d.%m.}: {geprueft}/{geprueft} grün",
              baue_html(befund, anzahl, alarm=False, kennzahlen=kennzahlen,
                        vorher=vorher),
              "Alle Sicherungen aktuell.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
