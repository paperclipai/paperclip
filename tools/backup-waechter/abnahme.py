#!/usr/bin/env python3
"""Wiedervorlage: Abnahme der Sicherungen nach einer Woche Regelbetrieb.

Kein blosser Erinnerungspiepser — der Bericht prueft und BELEGT den Zustand,
damit die Durchsicht Zahlen vor sich hat statt einer Aufforderung.

Geprueft wird:
  * alle sechs Datensaetze (aus `waechter`, gleiche Grenzen)
  * wie viele Snapshots je Schlagwort tatsaechlich entstanden sind — nach
    sieben Tagen taeglicher Laeufe muessen es mehrere sein; genau daran zeigt
    sich, ob der Regelbetrieb wirklich laeuft und nicht nur einmal lief
  * ob die Testsuiten der Sicherungswerkzeuge noch gruen sind
  * die offenen Punkte, die bei Walter liegen

WICHTIG: Wie alle Werkzeuge hier ueber node starten (TCC), siehe
`run-waechter.js` — die Abnahme laeuft ueber `run-abnahme.js`.

Usage: abnahme.py [--kein-versand]
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta

import pruefung
import waechter

# Was bei Walter liegt und sonst untergeht. Beim Abarbeiten hier streichen.
OFFENE_PUNKTE = """\
HAUPTPUNKT: Der Vault-Spiegel konvergiert nicht. Rund 1.870 Dateien werden \
JEDEN Lauf neu uebertragen, weil die NAS Dateinamen in NFD listet (oe = o + \
Trema) und der Mac in NFC — rsync haelt beide fuer verschiedene Dateien. \
Betroffen ist alles mit Umlauten oder Emoji. Der Spiegel ist trotzdem \
INHALTLICH KORREKT; der Schaden ist Doppelarbeit und ein wachsender \
Auffangordner (~3.870 Dateien je Lauf). `--iconv=UTF-8-MAC,UTF-8` scheidet \
aus: es scheitert an Emoji und wuerde 179 Dateien STILL auslassen. Am \
22.08. bewusst vertagt (Weg 1: so lassen, hier loesen). Auffangordner beim \
Loesen mit aufraeumen.
31 Anhaenge in "Alte E-Mail < 2025" sind ueber SMB nicht lesbar (Metadaten da, \
open scheitert, alle Namen mit Umlauten) — ueber DSM File Station pruefen.
kontakt.astro liegt unter whitestag-academy-web/_gerettet-2026-08-21/ — die \
einzige je existierende Kontaktseite; gehoert sie ins GitHub-Repo?
Altordner auf der NAS: WHITESTAG-Vault_OLD_2026-05-23 (6,5 GB) und die \
Migrationsreste unter /Volumes/WHITESTAG-ARCHIV/Obsidian/."""

WERKZEUGE = ("backup-waechter", "vault-nas-sync", "nextcloud-backup",
             "paperclip-db-backup", "llm-usage")


def betreff(befund) -> str:
    return ("Wiedervorlage Sicherungen: Problem" if not befund.ok
            else "Wiedervorlage Sicherungen: Abnahme")


def snapshots_je_schlagwort():
    """Anzahl Snapshots je Schlagwort, oder {} wenn das Repo stumm bleibt."""
    snaps = waechter.snapshots()
    if snaps is None:
        return {}
    zaehler = {}
    for s in snaps:
        for t in (s.get("tags") or []):
            if t == "automated":
                continue
            zaehler[t] = zaehler.get(t, 0) + 1
    return zaehler


def rote_tests():
    """[(werkzeug, kurzmeldung)] fuer jede Suite, die nicht gruen ist."""
    schlecht = []
    for w in WERKZEUGE:
        ordner = os.path.expanduser(f"~/.paperclip/scripts/{w}")
        if not os.path.isdir(ordner):
            continue
        try:
            r = subprocess.run(["/usr/bin/python3", "-m", "pytest", "-q"],
                               cwd=ordner, capture_output=True, text=True,
                               timeout=900)
        except (OSError, subprocess.TimeoutExpired) as exc:
            schlecht.append((w, f"nicht ausfuehrbar: {exc}"))
            continue
        if r.returncode != 0:
            letzte = [z for z in r.stdout.strip().splitlines() if z][-1:]
            schlecht.append((w, letzte[0] if letzte else f"rc={r.returncode}"))
    return schlecht


def baue_bericht(jetzt, befund, snaps, rot, offen) -> str:
    farbe = "#188038" if befund.ok else "#d93025"
    kopf = "Abnahme: alles grün" if befund.ok else "Abnahme: Problem gefunden"

    probleme = ""
    if befund.probleme:
        probleme = ("<p style='background:#fce8e6;border-left:3px solid #d93025;"
                    "padding:8px 12px'><b>Befund:</b><br>" +
                    "<br>".join(befund.probleme) + "</p>")

    zeilen = "".join(f"<li>{z}</li>" for z in befund.zeilen)

    snap_tab = ""
    if snaps:
        rows = "".join(
            f"<tr><td style='padding:3px 10px'>{t}</td>"
            f"<td style='padding:3px 10px;text-align:right'>{n}</td></tr>"
            for t, n in sorted(snaps.items()))
        snap_tab = (f"<h3 style='color:#1F3864;margin-bottom:4px'>Snapshots in "
                    f"der Nextcloud</h3><table style='font-size:14px'>{rows}"
                    f"</table><p style='color:#5f6368;font-size:13px'>Nach einer "
                    f"Woche täglicher Läufe sollten es mehrere sein — daran "
                    f"zeigt sich, ob der Regelbetrieb wirklich läuft.</p>")

    test_teil = ("<p style='color:#188038'><b>Alle Testsuiten grün.</b></p>"
                 if not rot else
                 "<p style='background:#fce8e6;padding:8px 12px'><b>Rote Tests:"
                 "</b><br>" + "<br>".join(f"{w}: {m}" for w, m in rot) + "</p>")

    offen_teil = ""
    if offen:
        punkte = "".join(f"<li>{z}</li>" for z in offen.strip().splitlines() if z)
        offen_teil = (f"<h3 style='color:#1F3864;margin-bottom:4px'>Offene Punkte"
                      f"</h3><ul style='font-size:14px;line-height:1.7'>{punkte}"
                      f"</ul>")

    return (f"<div style=\"font-family:-apple-system,Segoe UI,Arial,sans-serif;"
            f"color:#202124;max-width:680px\">"
            f"<h2 style='color:{farbe};margin-bottom:4px'>{kopf}</h2>"
            f"<p style='color:#5f6368;margin-top:0'>Wiedervorlage vom "
            f"{jetzt:%d.%m.%Y}, eine Woche nach dem Aufbau am 21./22.08.2026.</p>"
            f"{probleme}"
            f"<h3 style='color:#1F3864;margin-bottom:4px'>Stand der Sicherungen</h3>"
            f"<ul style='font-size:14px;line-height:1.7'>{zeilen}</ul>"
            f"{snap_tab}{test_teil}{offen_teil}"
            f"<p style='color:#9aa0a6;font-size:12px'>Einmalige Wiedervorlage "
            f"<code>de.whitestag.backup-abnahme</code>. Nach der Durchsicht "
            f"entladen: <code>launchctl bootout gui/$UID/"
            f"de.whitestag.backup-abnahme</code></p></div>")


def main():
    versand = "--kein-versand" not in sys.argv
    jetzt = datetime.now()

    stand_nas, anzahl = waechter.db_stand()
    snaps_roh = waechter.snapshots()

    def aus_repo(tag):
        return None if snaps_roh is None else pruefung.neuester_snapshot(snaps_roh, tag)

    prueflinge = [
        pruefung.Pruefling("Datenbank (NAS)", stand_nas,
                           waechter.GRENZE_TAEGLICH, "NAS"),
        pruefung.Pruefling("Datenbank (Nextcloud)", aus_repo(waechter.TAG_DB),
                           waechter.GRENZE_TAEGLICH, "restic"),
        pruefung.Pruefling("Claude-Code-Ordner (Nextcloud)",
                           aus_repo(waechter.TAG_CODE),
                           waechter.GRENZE_TAEGLICH, "restic"),
        pruefung.Pruefling("Vault-Spiegel (NAS)",
                           waechter.status_stand(waechter.VAULT_SYNC_STATUS),
                           waechter.GRENZE_TAEGLICH, "Statusdatei"),
        pruefung.Pruefling("Claude-Code-Spiegel (NAS)",
                           waechter.ordner_stand(waechter.SYNOLOGY_SPIEGEL),
                           waechter.GRENZE_SYNOLOGY, "Synology Drive"),
        pruefung.Pruefling("Vault (Nextcloud)", aus_repo(waechter.TAG_VAULT),
                           waechter.GRENZE_TAEGLICH, "restic"),
        pruefung.Pruefling("Repo-Pruefung (Hetzner)",
                           waechter.status_stand(waechter.REPO_PRUEF_STATUS),
                           waechter.GRENZE_REPO_PRUEFUNG, "Statusdatei"),
    ]
    befund = pruefung.bewerte(jetzt, prueflinge)

    kontingent = (waechter.KONTINGENT_GB * 1024 ** 3
                  if waechter.KONTINGENT_GB else None)
    platz_problem, platz_zeile = pruefung.bewerte_platz(
        waechter.belegung(), kontingent, waechter.PLATZ_SCHWELLE)
    befund = pruefung.Befund(
        ok=befund.ok and platz_problem is None,
        probleme=befund.probleme + ([platz_problem] if platz_problem else []),
        zeilen=befund.zeilen + [platz_zeile])

    snaps = snapshots_je_schlagwort()
    rot = rote_tests()
    if rot:
        befund = pruefung.Befund(False,
                                 befund.probleme + [f"Rote Tests: {w}" for w, _ in rot],
                                 befund.zeilen)

    for z in befund.zeilen:
        print(z)
    print("Snapshots:", snaps)
    print("Rote Tests:", rot or "keine")

    if versand:
        html = baue_bericht(jetzt, befund, snaps, rot, OFFENE_PUNKTE)
        waechter.sende(betreff(befund), html,
                       betreff(befund) + " — Bericht im HTML-Teil.")
    return 0 if befund.ok else 1


if __name__ == "__main__":
    sys.exit(main())
