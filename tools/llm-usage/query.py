#!/usr/bin/env python3
"""Gemeinsames Query-Modul für die LLM-Nutzungsauswertung.

Datenquelle: Paperclip-DB (cost_events + heartbeat_runs + agents).
Erfasst NUR Paperclip-Agenten-Calls — nicht n8n-AI-Nodes, PII-Proxy,
LM-Studio-Direktnutzung oder Claude Code selbst.
"""
import os
import psycopg2

import pricing

DSN = os.environ.get(
    "PAPERCLIP_DSN",
    "host=localhost port=54329 dbname=paperclip user=paperclip password=paperclip",
)
TZ = "Europe/Berlin"


def _conn():
    return psycopg2.connect(DSN)


def per_llm_per_day(days: int = 7):
    """Tabelle 1: LLM; Datum; Anzahl Aufrufe; Token; Dauer der Läufe (Sek.).

    Dauer = Summe der (distinkten) Laufzeiten der Runs, in denen das Modell
    an dem Tag verwendet wurde (finished_at - started_at).
    """
    sql = f"""
    WITH ev AS (
        SELECT ce.model,
               (ce.occurred_at AT TIME ZONE %s)::date AS tag,
               ce.heartbeat_run_id,
               ce.input_tokens, ce.cached_input_tokens, ce.output_tokens,
               hr.started_at, hr.finished_at
        FROM cost_events ce
        JOIN heartbeat_runs hr ON hr.id = ce.heartbeat_run_id
        WHERE ce.occurred_at >= now() - (%s || ' days')::interval
    ),
    runs AS (
        SELECT model, tag, heartbeat_run_id,
               GREATEST(EXTRACT(EPOCH FROM (max(finished_at) - min(started_at))), 0) AS dur
        FROM ev
        WHERE started_at IS NOT NULL AND finished_at IS NOT NULL
        GROUP BY 1, 2, 3
    )
    SELECT e.model,
           e.tag,
           count(*)                              AS calls,
           sum(e.input_tokens)                   AS in_tok,
           sum(e.cached_input_tokens)            AS cached_tok,
           sum(e.output_tokens)                  AS out_tok,
           sum(e.input_tokens + e.output_tokens) AS tokens,
           COALESCE((SELECT round(sum(r.dur))::bigint FROM runs r
                     WHERE r.model = e.model AND r.tag = e.tag), 0) AS dur_sec
    FROM ev e
    GROUP BY 1, 2
    ORDER BY e.tag DESC, calls DESC;
    """
    with _conn() as c, c.cursor() as cur:
        cur.execute(sql, (TZ, str(days)))
        # (model, tag, calls, in_tok, cached_tok, out_tok, tokens, dur_sec)
        return cur.fetchall()


def per_agent_call(days: int = 7):
    """Tabelle 2: Agent; Datum; Uhrzeit; LLM — eine Zeile je Aufruf."""
    sql = f"""
    SELECT a.name AS agent,
           (ce.occurred_at AT TIME ZONE %s)::date              AS tag,
           to_char(ce.occurred_at AT TIME ZONE %s, 'HH24:MI:SS') AS zeit,
           ce.model,
           ce.input_tokens + ce.output_tokens                  AS tokens
    FROM cost_events ce
    JOIN agents a ON a.id = ce.agent_id
    WHERE ce.occurred_at >= now() - (%s || ' days')::interval
    ORDER BY ce.occurred_at DESC;
    """
    with _conn() as c, c.cursor() as cur:
        cur.execute(sql, (TZ, TZ, str(days)))
        return cur.fetchall()  # (agent, tag, zeit, model, tokens)


def totals_by_model(days: int = 7):
    """Aggregat für Grafik/Digest: Modell -> (calls, tokens, dur_sec, kosten_eur).

    Kosten werden je Tag gerechnet, nicht auf die Summe — sonst würde ein
    Einführungspreis mit Ablaufdatum (siehe pricing.INTRO) über die Grenze
    hinweg falsch angewandt. `None` bleibt `None`: ein Modell ohne hinterlegten
    Preis darf die Summe nicht heimlich verkleinern.
    """
    rows = per_llm_per_day(days)
    agg = {}
    for model, tag, calls, in_tok, cached_tok, _out, tokens, dur in rows:
        c, t, d, k = agg.get(model, (0, 0, 0, 0.0))
        teil = pricing.kosten_eur(model, in_tok, cached_tok, _out, tag)
        if k is None or teil is None:
            k = None
        else:
            k += teil
        agg[model] = (c + calls, t + (tokens or 0), d + (dur or 0), k)
    return sorted(
        ([m, v[0], v[1], v[2], v[3]] for m, v in agg.items()),
        key=lambda r: r[1], reverse=True,
    )


def agent_hour(days: int = 7):
    """Agent × LLM je Stunde: Agent; Datum; Stunde; LLM; Aufrufe; Token.

    Stundenweise verdichtet, damit die Tabelle handhabbar bleibt.
    """
    sql = """
    SELECT a.name AS agent,
           (ce.occurred_at AT TIME ZONE %s)::date                 AS tag,
           to_char(ce.occurred_at AT TIME ZONE %s, 'HH24:00')     AS stunde,
           ce.model,
           count(*)                                               AS calls,
           sum(ce.input_tokens + ce.output_tokens)               AS tokens
    FROM cost_events ce
    JOIN agents a ON a.id = ce.agent_id
    WHERE ce.occurred_at >= now() - (%s || ' days')::interval
    GROUP BY 1, 2, 3, 4
    ORDER BY 2 DESC, 3 DESC, calls DESC;
    """
    with _conn() as c, c.cursor() as cur:
        cur.execute(sql, (TZ, TZ, str(days)))
        return cur.fetchall()  # (agent, tag, stunde, model, calls, tokens)


def matrix_day_by_model(days: int = 7):
    """Für gestapelte Grafik: (tage_sortiert, modelle_sortiert, counts[(tag,model)])."""
    rows = per_llm_per_day(days)
    tage = sorted({str(r[1]) for r in rows})
    modelle = [m for m, *_ in totals_by_model(days)]  # nach Gesamt-Aufrufen sortiert
    counts = {}
    for model, tag, calls, *_ in rows:
        counts[(str(tag), model)] = calls
    return tage, modelle, counts


def matrix_agent_by_model(days: int = 7):
    """Für gestapelte Grafik: (agenten_sortiert, modelle_sortiert, counts[(agent,model)])."""
    agg = {}
    model_tot = {}
    agent_tot = {}
    for agent, _tag, _stunde, model, calls, _tok in agent_hour(days):
        agg[(agent, model)] = agg.get((agent, model), 0) + calls
        model_tot[model] = model_tot.get(model, 0) + calls
        agent_tot[agent] = agent_tot.get(agent, 0) + calls
    agenten = sorted(agent_tot, key=lambda a: agent_tot[a], reverse=True)
    modelle = sorted(model_tot, key=lambda m: model_tot[m], reverse=True)
    return agenten, modelle, agg


def per_llm_on_day(day: str):
    """Digest-Tag: Modell -> (calls, tokens, dur_sec) für ein Kalenderdatum.

    `day` als 'YYYY-MM-DD' in Europe/Berlin. Leere Liste, wenn nichts anfiel.
    """
    sql = """
    WITH ev AS (
        SELECT ce.model, ce.heartbeat_run_id,
               ce.input_tokens, ce.cached_input_tokens, ce.output_tokens,
               hr.started_at, hr.finished_at
        FROM cost_events ce
        JOIN heartbeat_runs hr ON hr.id = ce.heartbeat_run_id
        WHERE (ce.occurred_at AT TIME ZONE %s)::date = %s::date
    ),
    runs AS (
        SELECT model, heartbeat_run_id,
               GREATEST(EXTRACT(EPOCH FROM (max(finished_at) - min(started_at))), 0) AS dur
        FROM ev
        WHERE started_at IS NOT NULL AND finished_at IS NOT NULL
        GROUP BY 1, 2
    )
    SELECT e.model,
           count(*)                                AS calls,
           sum(e.input_tokens + e.output_tokens)   AS tokens,
           COALESCE((SELECT round(sum(r.dur))::bigint FROM runs r
                     WHERE r.model = e.model), 0)   AS dur_sec,
           sum(e.input_tokens)                     AS in_tok,
           sum(e.cached_input_tokens)              AS cached_tok,
           sum(e.output_tokens)                    AS out_tok
    FROM ev e
    GROUP BY 1
    ORDER BY calls DESC;
    """
    from datetime import date as _date
    d = _date.fromisoformat(day) if isinstance(day, str) else day
    with _conn() as c, c.cursor() as cur:
        cur.execute(sql, (TZ, day))
        # (model, calls, tokens, dur_sec, kosten_eur) — die Token-Spalten
        # dienen nur der Kostenrechnung und werden nicht durchgereicht.
        return [
            (model, calls, tokens, dur,
             pricing.kosten_eur(model, in_tok, cached_tok, out_tok, d))
            for model, calls, tokens, dur, in_tok, cached_tok, out_tok in cur.fetchall()
        ]


def agent_model_on_day(day: str):
    """Ein Kalendertag in voller Aufloesung: Agent × Modell.

    Liefert (agent, modell, aufrufe, in_tok, cached_tok, out_tok). Daraus fallen
    sowohl die Agenten-Aufstellung als auch die Kreuztabelle der Vault-Notiz ab —
    und die Kosten je Agent, die sich nur je Modell rechnen lassen.

    LEFT JOIN mit Absicht: `cost_events.agent_id` hat keine Loesch-Kaskade
    (`NO ACTION`), aber ein Datensatz ohne passenden Agenten duerfte trotzdem
    nicht still verschwinden — sonst widerspraeche die Agenten-Summe der
    Modell-Summe und niemand saehe es. Er landet unter '(unbekannt)'.
    """
    sql = """
    SELECT COALESCE(a.name, '(unbekannt)')  AS agent,
           ce.model                          AS modell,
           count(*)                          AS aufrufe,
           sum(ce.input_tokens)              AS in_tok,
           sum(ce.cached_input_tokens)       AS cached_tok,
           sum(ce.output_tokens)             AS out_tok
    FROM cost_events ce
    LEFT JOIN agents a ON a.id = ce.agent_id
    WHERE (ce.occurred_at AT TIME ZONE %s)::date = %s::date
    GROUP BY 1, 2
    ORDER BY aufrufe DESC, agent, modell;
    """
    with _conn() as c, c.cursor() as cur:
        cur.execute(sql, (TZ, day))
        return cur.fetchall()


def yesterday_berlin():
    with _conn() as c, c.cursor() as cur:
        cur.execute(
            "SELECT ((now() AT TIME ZONE %s)::date - 1)::text", (TZ,)
        )
        return cur.fetchone()[0]


def totals_by_agent(days: int = 7):
    """Aggregat für Grafik: Agent -> calls (absteigend)."""
    rows = per_agent_call(days)
    agg = {}
    for agent, _tag, _zeit, _model, _tok in rows:
        agg[agent] = agg.get(agent, 0) + 1
    return sorted(agg.items(), key=lambda r: r[1], reverse=True)
