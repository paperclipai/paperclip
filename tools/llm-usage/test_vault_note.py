#!/usr/bin/env python3
"""Tests des Vault-Notiz-Bauers. Aufruf: python3 -m pytest test_vault_note.py -q

`vault_note.build()` ist bewusst eine reine Funktion ohne DB und ohne
Dateizugriff — nur so laesst sich das Format pruefen, ohne einen Tag Nutzung
in Postgres nachstellen zu muessen.
"""
from datetime import date

import vault_note

# --- Testdaten -------------------------------------------------------------
# Form wie query.per_llm_on_day(): (modell, aufrufe, token, dauer_sek, kosten)
MODELL_ROWS = [
    ("qwen3.6-35b-a3b-mlx", 200, 1_000_000, 3600, 0.0),
    ("claude-sonnet-4-6", 100, 500_000, 1800, 1.73),
]
# Form wie query.agent_model_on_day(): (agent, modell, aufrufe, in, cached, out)
AGENT_MODELL_ROWS = [
    ("CTO", "qwen3.6-35b-a3b-mlx", 120, 600_000, 0, 60_000),
    ("CTO", "claude-sonnet-4-6", 60, 300_000, 100_000, 30_000),
    ("CEO", "qwen3.6-35b-a3b-mlx", 80, 400_000, 0, 40_000),
    ("CEO", "claude-sonnet-4-6", 40, 200_000, 50_000, 20_000),
]
TAG = date(2026, 8, 19)


def frontmatter(text):
    """Skalare `schluessel: wert`-Zeilen aus dem Frontmatter als dict.

    Absichtlich ohne PyYAML: /usr/bin/python3 hat es nicht, und genau dieser
    Interpreter faehrt den launchd-Job. Was der Test nicht parsen kann, darf
    die Notiz gar nicht erst enthalten.
    """
    assert text.startswith("---\n"), "Notiz muss mit Frontmatter beginnen"
    block = text.split("---\n", 2)[1]
    out = {}
    for line in block.splitlines():
        if line.startswith((" ", "-")) or ":" not in line:
            continue  # verschachtelte Ebene (je_modell, tags) ueberspringen
        k, v = line.split(":", 1)
        out[k.strip()] = v.strip()
    return out


def test_frontmatter_traegt_die_tagessummen():
    """Der Kern fuer Langzeitauswertungen: Dataview liest genau diese Felder."""
    fm = frontmatter(vault_note.build(TAG, MODELL_ROWS, AGENT_MODELL_ROWS))
    assert fm["datum"] == "2026-08-19"
    assert fm["aufrufe"] == "300"
    assert fm["token"] == "1500000"
    assert fm["kosten_eur"] == "1.73"
    assert fm["modelle"] == "2"
    assert fm["agenten"] == "2"


def test_frontmatter_zahlen_bleiben_maschinenlesbar():
    """Im Body steht '1.500.000' (deutsch), im Frontmatter muss die nackte Zahl
    stehen — sonst liest Dataview sie als Text und jede Summe scheitert."""
    text = vault_note.build(TAG, MODELL_ROWS, AGENT_MODELL_ROWS)
    fm = frontmatter(text)
    assert "." not in fm["aufrufe"]
    assert "." not in fm["token"]
    assert "€" not in fm["kosten_eur"]
    assert "1.500.000" in text  # deutsche Formatierung gehoert in den Body


def test_agenten_werden_ueber_modelle_summiert():
    """CTO nutzt zwei Modelle und darf trotzdem nur eine Agenten-Zeile haben."""
    text = vault_note.build(TAG, MODELL_ROWS, AGENT_MODELL_ROWS)
    agent_block = text.split("## Je Agent", 1)[1].split("##", 1)[0]
    cto = [z for z in agent_block.splitlines() if z.startswith("| CTO ")]
    assert len(cto) == 1, agent_block
    assert "180" in cto[0]  # 120 + 60 Aufrufe


def test_kreuztabelle_fuehrt_jede_agent_modell_kombination():
    text = vault_note.build(TAG, MODELL_ROWS, AGENT_MODELL_ROWS)
    kreuz = text.split("## Agent × Modell", 1)[1]
    for agent, modell, *_ in AGENT_MODELL_ROWS:
        assert f"| {agent} | {modell} |" in kreuz, (agent, modell)


def test_pipe_im_agentennamen_zerstoert_die_tabelle_nicht():
    """Ein '|' im Namen wuerde die Markdown-Tabelle sonst still zerlegen."""
    rows = [("Boes|er Agent", "qwen3.6-35b-a3b-mlx", 5, 100, 0, 10)]
    text = vault_note.build(TAG, MODELL_ROWS, rows)
    agent_block = text.split("## Je Agent", 1)[1].split("##", 1)[0]
    zeile = [z for z in agent_block.splitlines() if "er Agent" in z]
    assert len(zeile) == 1
    assert r"Boes\|er Agent" in zeile[0]  # Markdown-Escape, Name bleibt lesbar
    # Nur die *unmaskierten* Pipes trennen Spalten: 4 Spalten -> 5 Trenner.
    assert zeile[0].replace(r"\|", "").count("|") == 5


def test_tag_ohne_daten_erzeugt_keine_notiz():
    """Sonst stehen im Vault 123 Leichen fuer Tage, an denen nichts lief."""
    assert vault_note.build(TAG, [], []) is None


def test_unbekannter_preis_wird_im_frontmatter_markiert():
    """Ein neues Anthropic-Modell ohne Preiszeile darf die Summe nicht
    heimlich verkleinern — dieselbe Regel wie in pricing.py."""
    rows = MODELL_ROWS + [("claude-supernova-9", 10, 1000, 5, None)]
    fm = frontmatter(vault_note.build(TAG, rows, AGENT_MODELL_ROWS))
    assert fm["kosten_unvollstaendig"] == "true"
    assert fm["kosten_eur"] == "1.73"  # bekannte Kosten weiter ausgewiesen


def test_vollstaendige_kosten_ohne_warnflagge():
    fm = frontmatter(vault_note.build(TAG, MODELL_ROWS, AGENT_MODELL_ROWS))
    assert fm.get("kosten_unvollstaendig") == "false"


def test_dateiname_kollidiert_nicht_mit_den_tagesprotokollen():
    """'2026-08-19.md' gibt es im Vault schon — Obsidian-Links waeren zweideutig."""
    assert vault_note.dateiname(TAG) == "LLM-Nutzung 2026-08-19.md"


def test_csv_eine_zeile_je_agent_und_modell_mit_kosten():
    zeilen = vault_note.csv_zeilen(TAG, AGENT_MODELL_ROWS)
    assert len(zeilen) == 4
    tag, agent, modell, aufrufe, token, kosten = zeilen[0]
    assert tag == "2026-08-19"
    assert (agent, modell, aufrufe) == ("CTO", "qwen3.6-35b-a3b-mlx", 120)
    assert token == 660_000  # in + out, wie in query.py
    assert kosten == 0.0     # lokales Modell


def test_csv_kosten_bei_unbekanntem_preis_sind_leer_nicht_null():
    """Auch hier: 0 waere gelogen, leer ist ehrlich."""
    zeilen = vault_note.csv_zeilen(TAG, [("X", "claude-supernova-9", 1, 10, 0, 5)])
    assert zeilen[0][-1] == ""
