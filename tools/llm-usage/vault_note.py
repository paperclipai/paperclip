#!/usr/bin/env python3
"""Baut die Obsidian-Tagesnotiz zur LLM-Nutzung.

Warum es das gibt: bis 08/2026 existierte die Auswertung nur als Mail und als
XLSX-Anhang. Der Mail-Spiegel im Vault traegt aber nur den Betreff — der
Plaintext-Teil der Mail *ist* die Betreffzeile (digest.py: `"text": subject`),
die Tabellen stecken allein im HTML. Damit war im Vault nichts auswertbar.

Diese Notiz schliesst die Luecke und ist zugleich die einzige Kopie der
Kostenhistorie ausserhalb der Paperclip-Datenbank — die hat keinen Backup-Job,
und ein geloeschter Mandant nimmt seine `cost_events` mit (services/companies.ts).

Bewusst eine reine Funktion: keine DB, kein Dateizugriff, kein PyYAML
(/usr/bin/python3 hat es nicht, und genau der faehrt den launchd-Job).
"""
from datetime import date
from typing import Optional

import pricing

TZ_HINWEIS = (
    "Quelle: Paperclip `cost_events` (Europe/Berlin). Nicht enthalten: "
    "n8n-AI-Nodes, PII-Proxy, LM-Studio-Direktnutzung, Claude Code. "
    "Kosten sind aus den Token gerechnet (`pricing.py`), nicht aus "
    "`cost_events.cost_cents` — die Spalte fuellt Paperclip fuer "
    "Anthropic-Modelle nicht. Lokale Modelle kosten 0 €."
)


def _de(n) -> str:
    """1500000 -> '1.500.000' (nur fuer den Body, nie fuers Frontmatter)."""
    return f"{int(n or 0):,}".replace(",", ".")


def _hms(sec) -> str:
    sec = int(sec or 0)
    h, rest = divmod(sec, 3600)
    m, s = divmod(rest, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _zelle(text) -> str:
    """Tabellenzelle absichern: ein '|' im Namen wuerde die Spalten zerlegen."""
    return str(text).replace("|", r"\|")


def _yaml_str(text) -> str:
    """Frontmatter-Wert quoten. Modell-IDs enthalten ':' und '[1m]' — beides
    bringt einen YAML-Parser sonst aus dem Tritt."""
    return '"' + str(text).replace("\\", "\\\\").replace('"', '\\"') + '"'


def agent_summen(agent_model_rows, tag: Optional[date] = None):
    """(agent, aufrufe, token, kosten) je Agent, ueber alle Modelle summiert.

    Kosten koennen nur je Modell gerechnet werden — deshalb kommt diese
    Aufstellung aus der Agent×Modell-Aufloesung und nicht aus einer eigenen
    Abfrage. `None` bleibt `None`: ein Modell ohne Preis darf die Summe des
    Agenten nicht heimlich verkleinern (gleiche Regel wie in pricing.py).
    """
    agg = {}
    for agent, modell, calls, in_tok, cached, out_tok in agent_model_rows:
        c, t, k = agg.get(agent, (0, 0, 0.0))
        teil = pricing.kosten_eur(modell, in_tok, cached, out_tok, tag)
        if k is None or teil is None:
            k = None
        else:
            k += teil
        agg[agent] = (c + calls, t + (in_tok or 0) + (out_tok or 0), k)
    return sorted(
        ((a, v[0], v[1], v[2]) for a, v in agg.items()),
        key=lambda r: r[1], reverse=True,
    )


def dateiname(tag: date) -> str:
    """'LLM-Nutzung 2026-08-19.md'.

    Nicht '2026-08-19.md': unter Tagesprotokolle/ gibt es diesen Namen schon,
    und Obsidian-Links waeren dann zweideutig.
    """
    return f"LLM-Nutzung {tag.isoformat()}.md"


def csv_zeilen(tag: date, agent_model_rows):
    """Zeilen fuer die kumulative CSV: (tag, agent, modell, aufrufe, token, kosten).

    Reihenfolge wie geliefert — die Abfrage sortiert bereits nach Aufrufen.
    Unbekannter Preis wird zu '' und nicht zu 0; 0 waere schlicht gelogen.
    """
    zeilen = []
    for agent, modell, calls, in_tok, cached, out_tok in agent_model_rows:
        k = pricing.kosten_eur(modell, in_tok, cached, out_tok, tag)
        zeilen.append((
            tag.isoformat(), agent, modell, calls,
            (in_tok or 0) + (out_tok or 0),
            "" if k is None else round(k, 4),
        ))
    return zeilen


def build(tag: date, modell_rows, agent_model_rows) -> Optional[str]:
    """Die fertige Notiz — oder None, wenn an dem Tag nichts lief.

    `modell_rows` wie query.per_llm_on_day(): (modell, aufrufe, token, dauer, kosten)
    `agent_model_rows` wie query.agent_model_on_day(): (agent, modell, aufrufe,
    in_tok, cached_tok, out_tok)

    None statt einer leeren Notiz, damit im Vault keine Karteileichen fuer
    Tage stehen, an denen kein Agent lief.
    """
    if not modell_rows and not agent_model_rows:
        return None

    aufrufe = sum(r[1] for r in modell_rows)
    token = sum(r[2] or 0 for r in modell_rows)
    dauer = sum(r[3] or 0 for r in modell_rows)
    bekannt = [r[4] for r in modell_rows if r[4] is not None]
    kosten = sum(bekannt)
    unvollstaendig = len(bekannt) < len(modell_rows)

    agenten = agent_summen(agent_model_rows, tag)

    # --- Frontmatter: ausschliesslich nackte Zahlen, damit Dataview rechnen kann
    fm = [
        "---",
        "typ: llm-nutzung",
        f"datum: {tag.isoformat()}",
        f"aufrufe: {aufrufe}",
        f"token: {token}",
        f"kosten_eur: {kosten:.2f}",
        f"kosten_unvollstaendig: {'true' if unvollstaendig else 'false'}",
        f"laufzeit_sek: {int(dauer)}",
        f"modelle: {len(modell_rows)}",
        f"agenten: {len(agenten)}",
    ]
    if modell_rows:
        fm.append(f"top_modell: {_yaml_str(modell_rows[0][0])}")
    if agenten:
        fm.append(f"top_agent: {_yaml_str(agenten[0][0])}")
    fm.append("je_modell:")
    for modell, calls, tok, _dauer, k in modell_rows:
        fm += [
            f"  - modell: {_yaml_str(modell)}",
            f"    aufrufe: {calls}",
            f"    token: {tok or 0}",
            f"    kosten_eur: {'null' if k is None else f'{k:.4f}'}",
        ]
    fm += ["tags:", "  - llm-nutzung", "  - auswertung", "  - paperclip", "---", ""]

    # --- Body
    body = [
        f"# LLM-Nutzung {tag.isoformat()}",
        "",
        f"Paperclip-Agenten · {_de(aufrufe)} Aufrufe · {_de(token)} Token · "
        f"Laufzeit {_hms(dauer)} · **Kosten {pricing.fmt_eur(kosten)}**",
        "",
    ]

    offen = pricing.unbekannte([r[0] for r in modell_rows])
    if offen:
        body += [
            f"> [!warning] Preis nicht hinterlegt: {', '.join(offen)}",
            "> Diese Aufrufe fehlen in den Kostensummen. Preis in `pricing.py` ergaenzen.",
            "",
        ]

    body += ["## Je Modell", "", "| Modell | Aufrufe | Token | Laufzeit | Kosten |",
             "| --- | ---: | ---: | ---: | ---: |"]
    for modell, calls, tok, dur, k in modell_rows:
        body.append(f"| {_zelle(modell)} | {_de(calls)} | {_de(tok)} | "
                    f"{_hms(dur)} | {pricing.fmt_eur(k)} |")

    body += ["", "## Je Agent", "", "| Agent | Aufrufe | Token | Kosten |",
             "| --- | ---: | ---: | ---: |"]
    for agent, calls, tok, k in agenten:
        body.append(f"| {_zelle(agent)} | {_de(calls)} | {_de(tok)} | "
                    f"{pricing.fmt_eur(k)} |")

    body += ["", "## Agent × Modell", "", "| Agent | Modell | Aufrufe | Token |",
             "| --- | --- | ---: | ---: |"]
    for agent, modell, calls, in_tok, _cached, out_tok in agent_model_rows:
        body.append(f"| {_zelle(agent)} | {_zelle(modell)} | {_de(calls)} | "
                    f"{_de((in_tok or 0) + (out_tok or 0))} |")

    body += ["", "---", "", f"*{TZ_HINWEIS}*", ""]
    return "\n".join(fm + body)
