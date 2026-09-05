"""Tests für weekly_claude_report (pytest)."""
import datetime as dt
import os
import time
from pathlib import Path

import pytest

import weekly_claude_report as wr


# --------------------------------------------------------------------------- #
# Section-Extraktion
# --------------------------------------------------------------------------- #
def test_extract_claude_section_stops_at_next_h2():
    md = (
        "# 2026-06-12\n\n"
        "## Claude Code\n\n"
        "1. **Alpha** — tat A\n"
        "2. **Beta** — tat B\n\n"
        "## Health\n\n"
        "### Schlaf\n"
        "egal\n"
    )
    sec = wr.extract_claude_section(md)
    assert "**Alpha**" in sec and "**Beta**" in sec
    assert "Schlaf" not in sec and "Health" not in sec


def test_extract_returns_empty_without_section():
    assert wr.extract_claude_section("# Tag\n## Health\nfoo") == ""


# --------------------------------------------------------------------------- #
# Punkt-Parsing (inkl. unsauberer Nummern wie im echten Vault)
# --------------------------------------------------------------------------- #
def test_parse_points_basic():
    sec = "1. **n8n Daily Digest Fix** — Fehler X behoben\n2. **i18n** — Plugin"
    pts = wr.parse_points(sec)
    assert [p.head for p in pts] == ["n8n Daily Digest Fix", "i18n"]
    assert pts[0].detail == "Fehler X behoben"


def test_parse_points_handles_duplicate_and_gapped_numbers():
    sec = (
        "2. **Erster** — a\n"
        "2. **Zweiter** — b\n"
        "8. **Achter** — c\n"
        "\n"
        "10. **Zehnter** — d\n"
    )
    heads = [p.head for p in wr.parse_points(sec)]
    assert heads == ["Erster", "Zweiter", "Achter", "Zehnter"]


def test_parse_points_without_detail():
    pts = wr.parse_points("1. **Nur Stichwort**")
    assert pts[0].head == "Nur Stichwort" and pts[0].detail == ""


# --------------------------------------------------------------------------- #
# Frontmatter
# --------------------------------------------------------------------------- #
def test_split_frontmatter():
    text = (
        "---\n"
        "title: Mein Titel\n"
        "tags: [n8n, telegram, bugfix]\n"
        "zusammenfassung: Kurz und knapp.\n"
        "---\n\n"
        "## Body\nInhalt\n"
    )
    meta, body = wr.split_frontmatter(text)
    assert meta["title"] == "Mein Titel"
    assert wr._parse_tags(meta["tags"]) == ["n8n", "telegram", "bugfix"]
    assert body.startswith("## Body")


# --------------------------------------------------------------------------- #
# Matching
# --------------------------------------------------------------------------- #
def _doc(title, tags=(), zus="", body="x"):
    return wr.ChatDoc(path=Path("/x.md"), title=title, tags=list(tags),
                      zusammenfassung=zus, body=body)


def test_best_match_picks_topic_overlap():
    point = wr.Point(head="n8n Telegram Truncation-Bug",
                     detail="Daily Digest am \\n gekürzt")
    docs = [
        _doc("LM Studio Draftmodelle", ["lmstudio"]),
        _doc("n8n Telegram-Fix und DB-Cleanup", ["n8n", "telegram"],
             "Telegram-Kürzung gefixt"),
    ]
    m = wr.best_match(point, docs)
    assert m is not None and "Telegram" in m.title


def test_best_match_returns_none_below_threshold():
    point = wr.Point(head="Völlig anderes Thema XYZ")
    docs = [_doc("Kfz-Kauf Beratung", ["auto"])]
    assert wr.best_match(point, docs) is None


# --------------------------------------------------------------------------- #
# mtime → Uhrzeit
# --------------------------------------------------------------------------- #
def test_time_from_mtime(tmp_path):
    f = tmp_path / "x.md"
    f.write_text("hi")
    # Setze mtime auf 2026-06-14 08:29 Europe/Berlin
    target = dt.datetime(2026, 6, 14, 8, 29, tzinfo=wr.TZ)
    os.utime(f, (target.timestamp(), target.timestamp()))
    assert wr.time_from_mtime(f) == "08:29"


# --------------------------------------------------------------------------- #
# Summarizer-Fallback-Kette
# --------------------------------------------------------------------------- #
def test_summarize_uses_llm_when_available():
    doc = _doc("T", body="langer body text")
    out = wr.summarize_item(doc, wr.Point("H"),
                            summarizer=lambda b: ["a", "b", "c"])
    assert out == ["a", "b", "c"]


def test_summarize_falls_back_to_frontmatter_on_llm_error():
    doc = _doc("T", zus="Satz eins. Satz zwei. Satz drei.", body="body")

    def boom(_):
        raise RuntimeError("LLM down")

    out = wr.summarize_item(doc, wr.Point("H"), summarizer=boom)
    assert out == ["Satz eins.", "Satz zwei.", "Satz drei."]


def test_summarize_falls_back_to_point_detail_without_doc():
    out = wr.summarize_item(None, wr.Point("H", detail="Tat dies. Tat das."),
                            summarizer=lambda b: ["x"])
    assert out == ["Tat dies.", "Tat das."]


def test_three_lines_caps_at_three():
    assert wr._three_lines("a\nb\nc\nd\ne") == ["a", "b", "c"]


def test_three_lines_strips_list_markers_but_keeps_leading_numbers():
    out = wr._three_lines("1. Erste Zeile\n- Zweite Zeile\n16-seitiger Report erstellt")
    assert out == ["Erste Zeile", "Zweite Zeile", "16-seitiger Report erstellt"]


# --------------------------------------------------------------------------- #
# Tagesaufbereitung + Markdown end-to-end (mit Fixture-Vault)
# --------------------------------------------------------------------------- #
@pytest.fixture
def fixture_vault(tmp_path):
    vault = tmp_path / "Vault"
    (vault / "Tagesprotokolle").mkdir(parents=True)
    (vault / "Claude Code" / "Paperclip").mkdir(parents=True)

    # Tagesprotokoll mit 2 Claude-Code-Punkten + Health-Abschnitt
    (vault / "Tagesprotokolle" / "2026-06-14.md").write_text(
        "# 2026-06-14\n\n## Claude Code\n\n"
        "1. **LM Studio Draftmodelle** — Speedup gemessen\n"
        "2. **PII-Proxy Durchsetzung** — Hosts anonymisiert\n\n"
        "## Health\n### Schlaf\negal\n",
        encoding="utf-8",
    )
    # Passender Chatverlauf zu Punkt 1
    c1 = (vault / "Claude Code" / "Paperclip"
          / "2026-06-14 Chatverlauf LM Studio Draftmodelle.md")
    c1.write_text(
        "---\ntitle: LM Studio Draftmodelle\ntags: [lmstudio, draft]\n"
        "zusammenfassung: Draft-Speedup gemessen.\n---\n\nBody zu Draftmodellen.\n",
        encoding="utf-8",
    )
    t1 = dt.datetime(2026, 6, 14, 9, 15, tzinfo=wr.TZ).timestamp()
    os.utime(c1, (t1, t1))
    # Passender Chatverlauf zu Punkt 2 (früher → sollte zuerst gelistet werden)
    c2 = (vault / "Claude Code" / "Paperclip"
          / "2026-06-14 Chatverlauf PII-Proxy Durchsetzung.md")
    c2.write_text(
        "---\ntitle: PII-Proxy Durchsetzung\ntags: [pii, proxy]\n"
        "zusammenfassung: Hosts anonymisiert.\n---\n\nBody zum PII-Proxy.\n",
        encoding="utf-8",
    )
    t2 = dt.datetime(2026, 6, 14, 7, 5, tzinfo=wr.TZ).timestamp()
    os.utime(c2, (t2, t2))
    return vault


def test_build_day_items_sorted_by_time(fixture_vault):
    items = wr.build_day_items(dt.date(2026, 6, 14), fixture_vault,
                               summarizer=lambda b: ["s1", "s2", "s3"])
    assert [it.time for it in items] == ["07:05", "09:15"]
    assert items[0].head == "PII-Proxy Durchsetzung"


def test_summary_cache_calls_llm_once_per_doc():
    doc = _doc("T", body="body")
    calls = {"n": 0}

    def counting(_):
        calls["n"] += 1
        return ["a", "b", "c"]

    cache: dict = {}
    wr.summarize_item(doc, wr.Point("H1"), summarizer=counting, cache=cache)
    wr.summarize_item(doc, wr.Point("H2"), summarizer=counting, cache=cache)
    assert calls["n"] == 1  # zweiter Punkt nutzt den Cache


def test_build_day_items_empty_for_missing_proto(fixture_vault):
    assert wr.build_day_items(dt.date(2026, 6, 13), fixture_vault,
                              summarizer=lambda b: ["x"]) == []


def test_generate_report_covers_seven_days_and_marks_empty(fixture_vault):
    md, start, end = wr.generate_report(
        dt.date(2026, 6, 14), fixture_vault,
        summarizer=lambda b: ["s1", "s2", "s3"])
    assert start == dt.date(2026, 6, 8) and end == dt.date(2026, 6, 14)
    # Alle 7 Wochentage als Überschrift vorhanden
    for wd in wr.WEEKDAYS_DE:
        assert f"## {wd} ·" in md
    # Headline mit Uhrzeit + Stichwort
    assert "**07:05 — PII-Proxy Durchsetzung**" in md
    assert "**09:15 — LM Studio Draftmodelle**" in md
    # Leere Tage markiert
    assert "_Keine protokollierten Arbeiten._" in md
    # Sonntag (14.) hat Inhalt, Montag (8.) ist leer
    assert "KW24" in md


def test_iso_week_label():
    label = wr.iso_week_label(dt.date(2026, 6, 8), dt.date(2026, 6, 14))
    assert label.startswith("KW24") and "08.06." in label and "14.06.2026" in label
