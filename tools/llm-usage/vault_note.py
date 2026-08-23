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

import hosts
import pricing
import steckbrief

TZ_HINWEIS = (
    "Quelle: Paperclip `cost_events` (Europe/Berlin). Nicht enthalten: "
    "n8n-AI-Nodes, PII-Proxy, LM-Studio-Direktnutzung, Claude Code. "
    "Kosten sind aus den Token gerechnet (`pricing.py`), nicht aus "
    "`cost_events.cost_cents` — die Spalte fuellt Paperclip fuer "
    "Anthropic-Modelle nicht. Lokale Modelle kosten 0 €. "
    "`Wo` kommt aus der Zuordnung in `hosts.py` — `cost_events` fuehrt keinen "
    "Host, alle Agenten rufen `localhost:1234` und LM Link routet unsichtbar "
    "weiter. Vor dem 06.07.2026 war der Mac Studio der einzige LLM-Server, "
    "danach gilt die Tabelle; ein spaeterer Modellumzug muss dort nachgetragen "
    "werden, damit zurueckliegende Tage wieder stimmen. "
    "`Quant` und `CTX` (geladenes Fenster) kommen aus dem LM-Studio-Katalog "
    "`:1234/api/v0/models`, ersatzweise aus dem zuletzt gesehenen Stand; "
    "Anthropic hat keine Quantisierung, das Fenster ist 200K bzw. 1M. "
    "`Thinking` ist **gemessen**, nicht konfiguriert: Anteil der Vorhersagen "
    "mit `reasoning_tokens > 0` in den LM-Studio-Logs des Tages, `on` ab 5 %. "
    "Fuer Anthropic nicht ermittelbar."
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


def _ctx_zahl(modell, sb) -> str:
    """Kontextfenster als nackte Zahl fuers Frontmatter — Dataview soll damit
    rechnen koennen. '96K' waere Text."""
    e = steckbrief._eintrag(modell, sb or {})
    if steckbrief._ist_cloud(modell):
        n = (steckbrief.ANTHROPIC_CTX_1M
             if str(modell).strip().endswith("[1m]") else steckbrief.ANTHROPIC_CTX)
    else:
        n = e.get("ctx")
    return str(int(n)) if n else "null"


def _quote_zahl(modell, sb) -> str:
    """Denkquote als nackte Zahl. `null`, wenn nicht messbar — 0 waere gelogen."""
    q = steckbrief.denk_quote(modell, sb or {})
    return "null" if q is None else f"{q:.4g}"


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


def csv_zeilen(tag: date, agent_model_rows, sb=None):
    """Zeilen fuer die kumulative CSV.

    (tag, agent, modell, ort, quant, ctx, denkquote, aufrufe, token, kosten)

    Reihenfolge wie geliefert — die Abfrage sortiert bereits nach Aufrufen.
    `ctx` und `denkquote` sind nackte Zahlen, damit Dataview rechnen kann.
    Nicht Ermittelbares wird zu '' und nicht zu 0 — weder ein unbekannter
    Preis noch eine nicht gemessene Denkquote ist null.
    """
    zeilen = []
    for agent, modell, calls, in_tok, cached, out_tok in agent_model_rows:
        k = pricing.kosten_eur(modell, in_tok, cached, out_tok, tag)
        ctx = _ctx_zahl(modell, sb)
        quote = _quote_zahl(modell, sb)
        zeilen.append((
            tag.isoformat(), agent, modell, hosts.ort(modell, tag),
            steckbrief.quant(modell, sb),
            "" if ctx == "null" else int(ctx),
            "" if quote == "null" else float(quote),
            calls,
            (in_tok or 0) + (out_tok or 0),
            "" if k is None else round(k, 4),
        ))
    return zeilen


def build(tag: date, modell_rows, agent_model_rows, sb=None) -> Optional[str]:
    """Die fertige Notiz — oder None, wenn an dem Tag nichts lief.

    `modell_rows` wie query.per_llm_on_day(): (modell, aufrufe, token, dauer, kosten)
    `agent_model_rows` wie query.agent_model_on_day(): (agent, modell, aufrufe,
    in_tok, cached_tok, out_tok)

    `sb` ist der Steckbrief aus `steckbrief.erhebe()`. Fehlt er (backfill fuer
    einen Tag ohne Logs), stehen dort Fragezeichen statt einer Behauptung.

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
            f"    ort: {_yaml_str(hosts.ort(modell, tag))}",
            f"    quant: {_yaml_str(steckbrief.quant(modell, sb))}",
            f"    ctx: {_ctx_zahl(modell, sb)}",
            f"    denkquote: {_quote_zahl(modell, sb)}",
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

    # Gleiches Muster wie oben: eine handgepflegte Tabelle veraltet still,
    # wenn niemand sie auf ihre Luecken hinweist.
    ortlos = hosts.unbekannte([r[0] for r in modell_rows], tag)
    if ortlos:
        body += [
            f"> [!warning] Ausfuehrungsort nicht hinterlegt: {', '.join(ortlos)}",
            "> Geraet in `hosts.py` (`ZUORDNUNG`) ergaenzen — es steht in der "
            "DEVICE-Spalte von `lms ps`.",
            "",
        ]

    body += ["## Je Modell", "",
             "| Modell | Wo | Quant | CTX | Thinking | Aufrufe | Token | Laufzeit | Kosten |",
             "| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: |"]
    for modell, calls, tok, dur, k in modell_rows:
        body.append(f"| {_zelle(modell)} | {hosts.ort(modell, tag)} | "
                    f"{steckbrief.quant(modell, sb)} | {steckbrief.ctx(modell, sb)} | "
                    f"{steckbrief.thinking(modell, sb)} | {_de(calls)} | "
                    f"{_de(tok)} | {_hms(dur)} | {pricing.fmt_eur(k)} |")

    body += ["", "## Je Agent", "", "| Agent | Aufrufe | Token | Kosten |",
             "| --- | ---: | ---: | ---: |"]
    for agent, calls, tok, k in agenten:
        body.append(f"| {_zelle(agent)} | {_de(calls)} | {_de(tok)} | "
                    f"{pricing.fmt_eur(k)} |")

    body += ["", "## Agent × Modell", "",
             "| Agent | Modell | Wo | Aufrufe | Token |",
             "| --- | --- | --- | ---: | ---: |"]
    for agent, modell, calls, in_tok, _cached, out_tok in agent_model_rows:
        body.append(f"| {_zelle(agent)} | {_zelle(modell)} | {hosts.ort(modell, tag)} | "
                    f"{_de(calls)} | {_de((in_tok or 0) + (out_tok or 0))} |")

    body += ["", "---", "", f"*{TZ_HINWEIS}*", ""]
    return "\n".join(fm + body)
