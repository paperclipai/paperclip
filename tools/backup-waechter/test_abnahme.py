#!/usr/bin/env python3
"""Tests des Abnahmeberichts. Aufruf: python3 -m pytest test_abnahme.py -q"""
from datetime import datetime, timedelta

import abnahme
import pruefung

JETZT = datetime(2026, 8, 29, 9, 30)
STD = timedelta(hours=1)


def befund(ok=True):
    if ok:
        return pruefung.Befund(True, [], ["A: frisch", "B: frisch"])
    return pruefung.Befund(False, ["A: ueberfaellig"], ["A: alt", "B: frisch"])


def test_bericht_nennt_jede_sicherung():
    t = abnahme.baue_bericht(JETZT, befund(), {"paperclip-db": 7}, [], "")
    assert "A: frisch" in t and "B: frisch" in t


def test_bericht_zeigt_die_snapshot_zahlen():
    """Nach einer Woche taeglicher Laeufe muessen es mehrere sein — genau das
    soll die Abnahme belegen."""
    t = abnahme.baue_bericht(JETZT, befund(), {"paperclip-db": 7, "claude-code": 7}, [], "")
    assert "paperclip-db" in t and "7" in t


def test_probleme_stehen_ganz_oben():
    """Wer die Mail ueberfliegt, muss den Befund zuerst sehen."""
    t = abnahme.baue_bericht(JETZT, befund(ok=False), {}, [], "")
    kopf = t[:400]
    assert "ueberfaellig" in kopf, kopf


def test_rote_tests_erscheinen_im_bericht():
    t = abnahme.baue_bericht(JETZT, befund(), {}, [("vault-nas-sync", "2 failed")], "")
    assert "vault-nas-sync" in t and "2 failed" in t


def test_offene_punkte_werden_mitgefuehrt():
    """Die Dinge, die bei Walter liegen — sonst gehen sie unter."""
    t = abnahme.baue_bericht(JETZT, befund(), {}, [], "31 unlesbare Anhaenge")
    assert "31 unlesbare" in t


def test_betreff_unterscheidet_gruen_und_rot():
    assert "Problem" in abnahme.betreff(befund(ok=False))
    assert "Problem" not in abnahme.betreff(befund(ok=True))
