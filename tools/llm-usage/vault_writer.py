#!/usr/bin/env python3
"""Schreibt die LLM-Tagesnotiz und die kumulative CSV in den Obsidian-Vault.

Trennung mit Absicht: `vault_note` baut den Text (rein, testbar ohne Vault),
dieses Modul fasst als einziges das Dateisystem an.
"""
import csv
import os
from datetime import date
from pathlib import Path
from typing import Optional

import hosts
import steckbrief
import vault_note

VAULT_ZIEL = Path(os.path.expanduser(
    "~/Obsidian/WHITESTAG-Vault/Analysen/LLM-Nutzung"
))
CSV_UNTERORDNER = "_daten"
CSV_NAME = "llm-nutzung.csv"
CSV_KOPF = ["tag", "agent", "modell", "ort", "quant", "ctx", "denkquote",
            "aufrufe", "token", "kosten_eur"]
# Die kumulative CSV reicht bis zum 16.04.2026 zurueck und hat zwei aeltere
# Formate erlebt. Altzeilen werden beim naechsten Lauf auf die volle Breite
# gehoben — bliebe eine kurz, laegen ab der vierten Spalte alle Werte um eins
# daneben und jede Dataview-Auswertung waere still falsch.
CSV_KOEPFE_ALT = [
    ["tag", "agent", "modell", "aufrufe", "token", "kosten_eur"],          # bis 08/2026
    ["tag", "agent", "modell", "ort", "aufrufe", "token", "kosten_eur"],   # 23.08. vormittags
]


def _migriere(zeile: list, sb=None) -> list:
    """Eine Altzeile auf das aktuelle Format heben.

    Nachgetragen wird nur, was ableitbar ist: `ort` aus Modell-ID plus Tag der
    Zeile, `quant`/`ctx` aus dem Steckbrief. Die **Denkquote bleibt leer** —
    sie steht nur in den Logs des jeweiligen Tages, und ein erfundener Wert
    waere schlimmer als eine Luecke. `backfill.py` traegt sie nach, weil es
    die Logs ohnehin Tag fuer Tag liest.
    """
    if len(zeile) >= len(CSV_KOPF):
        return zeile
    tag, agent, modell = zeile[0], zeile[1], zeile[2]
    # 7 Spalten = Zwischenformat, `ort` steht schon drin und wird neu gesetzt.
    rest = zeile[4:] if len(zeile) == 7 else zeile[3:]
    ctx = vault_note._ctx_zahl(modell, sb)
    return [tag, agent, modell, hosts.ort(modell, tag),
            steckbrief.quant(modell, sb),
            "" if ctx == "null" else int(ctx),
            ""] + list(rest)


def schreibe_notiz(tag: date, modell_rows, agent_model_rows,
                   ziel=VAULT_ZIEL, sb=None) -> Optional[Path]:
    """Notiz schreiben; None, wenn an dem Tag nichts lief (keine Karteileiche)."""
    text = vault_note.build(tag, modell_rows, agent_model_rows, sb)
    if text is None:
        return None
    ziel = Path(ziel)
    ziel.mkdir(parents=True, exist_ok=True)
    pfad = ziel / vault_note.dateiname(tag)
    pfad.write_text(text, encoding="utf-8")
    return pfad


def schreibe_tag(tag: date, modell_rows, agent_model_rows, ziel=VAULT_ZIEL,
                 sb=None):
    """Notiz + CSV in einem Rutsch — die gemeinsame Klammer fuer Digest und Backfill.

    Gibt (notiz_pfad, csv_pfad) zurueck, bei einem Tag ohne Aufrufe (None, None):
    dann bleibt der Vault unberuehrt, auch die CSV.
    """
    notiz = schreibe_notiz(tag, modell_rows, agent_model_rows, ziel, sb)
    if notiz is None:
        return None, None
    return notiz, aktualisiere_csv(tag, agent_model_rows, ziel, sb)


def aktualisiere_csv(tag: date, agent_model_rows, ziel=VAULT_ZIEL,
                     sb=None) -> Path:
    """Zeilen des Tages in die kumulative CSV einpflegen — idempotent.

    Vorhandene Zeilen desselben Tages werden ersetzt, nicht ergaenzt. Sonst
    zaehlte jeder Wiederholungslauf (manueller Aufruf, Backfill, erneuter
    launchd-Start) den Tag ein weiteres Mal mit, und jede Langzeitauswertung
    daraus waere still falsch.
    """
    ordner = Path(ziel) / CSV_UNTERORDNER
    ordner.mkdir(parents=True, exist_ok=True)
    pfad = ordner / CSV_NAME
    tag_str = tag.isoformat()

    bestand = []
    if pfad.exists():
        with open(pfad, encoding="utf-8", newline="") as fh:
            leser = csv.reader(fh)
            for i, zeile in enumerate(leser):
                if i == 0 and zeile in [CSV_KOPF] + CSV_KOEPFE_ALT:
                    continue
                if zeile and zeile[0] != tag_str:
                    bestand.append(_migriere(zeile, sb))

    neu = [[str(f) for f in z] for z in
           vault_note.csv_zeilen(tag, agent_model_rows, sb)]
    alle = sorted(bestand + neu, key=lambda z: (z[0], z[1], z[2]))

    with open(pfad, "w", encoding="utf-8", newline="") as fh:
        schreiber = csv.writer(fh)
        schreiber.writerow(CSV_KOPF)
        schreiber.writerows(alle)
    return pfad
