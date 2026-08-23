#!/usr/bin/env python3
"""Tests des Mail-Bodys. Aufruf: python3 -m pytest test_digest.py -q

`digest.build_html()` ist eine reine Funktion — Datenbank und Mailversand
bleiben aussen vor.
"""
import digest

# Form wie query.per_llm_on_day(): (modell, aufrufe, token, dauer_sek, kosten)
ROWS = [
    ("gemma4-31b-it", 300, 1_000_000, 3600, 0.0),
    ("gemma-4-31b-it-mlx", 200, 800_000, 2400, 0.0),
    ("google/gemma-4-12b", 100, 200_000, 600, 0.0),
    ("claude-sonnet-4-6", 50, 500_000, 1800, 1.73),
]
WEEK = [
    ("gemma4-31b-it", 2000, 7_000_000, 25000, 0.0),
    ("claude-sonnet-4-6", 300, 3_000_000, 9000, 10.40),
]
TAG = "2026-08-22"


def tabelle(html, ueberschrift):
    """Den Abschnitt ab einer <h3>-Ueberschrift bis zum naechsten heraustrennen."""
    return html.split(ueberschrift, 1)[1].split("<h3", 1)[0]


def test_vortagstabelle_hat_eine_wo_spalte():
    html = digest.build_html(TAG, ROWS, WEEK)
    kopf = tabelle(html, "Je Modell (Vortag)")
    assert ">Wo<" in kopf


def test_wo_spalte_nennt_das_geraet_je_modell():
    """Der Punkt der ganzen Uebung: RTX, MacBook, Mac Studio und Cloud stehen
    nebeneinander in derselben Liste."""
    block = tabelle(digest.build_html(TAG, ROWS, WEEK), "Je Modell (Vortag)")
    for modell, erwartet in (
        ("gemma4-31b-it", "RTX"),
        ("gemma-4-31b-it-mlx", "MacBook"),
        ("google/gemma-4-12b", "Mac Studio"),
        ("claude-sonnet-4-6", "Cloud"),
    ):
        zeile = [z for z in block.split("<tr>") if f">{modell}<" in z]
        assert len(zeile) == 1, modell
        assert f">{erwartet}<" in zeile[0], (modell, zeile[0])


def test_auch_die_siebentagetabelle_traegt_den_ort():
    html = digest.build_html(TAG, ROWS, WEEK)
    block = html.split("7 Tage", 1)[1]
    zeile = [z for z in block.split("<tr>") if ">gemma4-31b-it<" in z]
    assert len(zeile) == 1
    assert ">RTX<" in zeile[0]


def test_unbekannter_ort_erzeugt_eine_warnzeile():
    """Gleiches Muster wie 'Preis nicht hinterlegt': ein neues lokales Modell
    soll auffallen, statt still als 'unbekannt' durchzulaufen."""
    rows = ROWS + [("irgendwas/neues-42b", 10, 1000, 5, 0.0)]
    html = digest.build_html(TAG, rows, WEEK)
    assert "Ausführungsort nicht hinterlegt" in html
    assert "irgendwas/neues-42b" in html.split("Ausführungsort nicht hinterlegt", 1)[1]


def test_ohne_unbekannte_modelle_keine_warnzeile():
    assert "Ausführungsort nicht hinterlegt" not in digest.build_html(TAG, ROWS, WEEK)


def test_abweichung_zur_live_belegung_wird_gemeldet():
    """Die Tabelle soll nicht still veralten, wenn ein Modell umzieht."""
    live = {"gemma4-31b-it": "MacBook"}
    html = digest.build_html(TAG, ROWS, WEEK, live=live)
    assert "Zuordnung veraltet" in html
    warnung = html.split("Zuordnung veraltet", 1)[1]
    assert "gemma4-31b-it" in warnung
    assert "MacBook" in warnung


def test_nicht_geladene_modelle_loesen_keinen_fehlalarm_aus():
    """Die RTX ist nachts aus. Der Digest laeuft um 08:00 — dass ein Modell in
    `lms ps` fehlt, heisst 'entladen', nicht 'umgezogen'."""
    html = digest.build_html(TAG, ROWS, WEEK, live={})
    assert "Zuordnung veraltet" not in html


def test_ohne_live_abgleich_wird_nichts_behauptet():
    """`lms ps` nicht erreichbar -> live=None -> kein Abgleich, keine Warnung."""
    html = digest.build_html(TAG, ROWS, WEEK, live=None)
    assert "Zuordnung veraltet" not in html


def test_leerer_tag_bleibt_darstellbar():
    """Die Platzhalterzeile muss ueber alle Spalten gehen, sonst bricht die
    Tabelle — mit der neuen Spalte sind es eine mehr."""
    html = digest.build_html(TAG, [], WEEK)
    assert "Keine Aufrufe an diesem Tag." in html
    assert "colspan='6'" in html
