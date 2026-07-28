"""Tests für den täglichen Engineering-Report (reine Logik, kein Netzwerk)."""
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(__file__))
import engineering_report as er  # noqa: E402


# --- Verdict / Snippet-Helfer -------------------------------------------------
def test_extract_verdict_findet_gelb():
    assert er.extract_verdict("## Lektorat-Urteil: GELB\nMangel …") == "GELB"


def test_extract_verdict_leer_ohne_treffer():
    assert er.extract_verdict("kein Urteil hier") == ""


def test_first_meaningful_line_ueberspringt_urteil_und_geprueft():
    body = "## Lektorat-Urteil: GELB\nGeprüft: datei.md\nEchte Aussage über den Mangel"
    assert er.first_meaningful_line(body) == "Echte Aussage über den Mangel"


def test_clean_snippet_normalisiert_und_kuerzt():
    assert er.clean_snippet("a\n\n  b   c", limit=5) == "a b c"
    assert len(er.clean_snippet("x" * 500)) == 380


# --- Datum / HTML-Escaping ----------------------------------------------------
def test_german_date():
    assert er.german_date(datetime(2026, 7, 28)) == "Dienstag, 28. Juli 2026"


def test_esc():
    assert er._esc("<a> & </b>") == "&lt;a&gt; &amp; &lt;/b&gt;"


def test_inline_fett_und_code():
    out = er._inline("**WHI-3253** und `npm test`")
    assert "<strong>WHI-3253</strong>" in out
    assert "<code" in out and "npm test</code>" in out


def test_heading_accent():
    assert er._heading_accent("Blockiert")[0] == "#b45309"
    assert er._heading_accent("WHITESTAG.ACADEMY (Workshop)")[0] == "#0b6b8a"
    assert er._heading_accent("Erledigt")[0] == "#1f7a4d"
    assert er._heading_accent("Sonstiges")[0] == "#012a3e"


# --- Fakten / Zählung ---------------------------------------------------------
def _facts():
    return {
        "by_status": {
            "done": [{"identifier": "WHI-1", "title": "Modellwechsel", "agent": "VP Engineering",
                      "status": "done", "updatedAt": "", "blockedBy": [], "context": "tat X"}],
            "in_progress": [],
            "blocked": [{"identifier": "WHI-2", "title": "Heartbeat", "agent": "n8n",
                         "status": "blocked", "updatedAt": "", "blockedBy": [], "context": "weil Y"}],
            "in_review": [], "todo": [],
        },
        "bugsweep": {"identifier": "WHI-9", "status": "done"},
        "academy": [{"identifier": "WHI-3", "title": "Kurs X", "agent": "Lektorat",
                     "status": "done", "verdict": "GELB", "note": "Dopplung", "context": "Kurs bereit"}],
        "window_hours": 24,
    }


def test_total_items_zaehlt_status_plus_academy():
    assert er.total_items(_facts()) == 3


def test_facts_markdown_enthaelt_alle_bloecke():
    md = er.facts_markdown(_facts())
    assert "## Erledigt" in md
    assert "- WHI-1 (VP Engineering): Modellwechsel" in md
    assert "Kontext: tat X" in md
    assert "kein First-Class-Blocker gesetzt" in md          # blocked ohne blockedBy
    assert "## WHITESTAG.ACADEMY (nächtlicher Workshop)" in md
    assert "Lektorat-Urteil: GELB" in md
    assert "Nebenbei: nächtlicher Bug-Sweep WHI-9" in md


def test_facts_markdown_leer():
    empty = {"by_status": {s: [] for s in er.STATUS_ORDER}, "bugsweep": None,
             "academy": [], "window_hours": 24}
    assert "Keine Engineering-Aktivität" in er.facts_markdown(empty)
    assert er.total_items(empty) == 0


# --- HTML-Rendering -----------------------------------------------------------
def test_render_body_listen_und_ueberschriften():
    html = er._render_body("## Erledigt\n- Punkt eins\n- Punkt zwei\nNormaler Absatz")
    assert "<ul" in html and html.count("<li") == 2
    assert "Erledigt" in html
    assert "<p" in html and "Normaler Absatz" in html


def test_render_html_grundgeruest():
    html = er.render_html("## Lage\nAlles ruhig.", "Engineering-Report",
                          "Dienstag, 28. Juli 2026")
    assert "background:#012a3e" in html          # Header-Markenfarbe
    assert "Engineering-Report" in html
    assert "Dienstag, 28. Juli 2026" in html
    assert "Automatischer Engineering-Report" in html   # Footer
