#!/usr/bin/env python3
"""Täglicher LLM-Nutzungs-Digest: HTML-Body für den Vortag + 7-Tage-Excel als Anhang.

Nur Paperclip-Agenten-Calls (cost_events). Rein deterministisch, kein LLM.
Wird per Mailhub (n8n-Webhook) an Walter gemailt.

Usage: digest.py [--day YYYY-MM-DD] [--dry-run] [--no-attach]
"""
import base64
import json
import os
import subprocess
import sys
import urllib.request
from datetime import date

import pricing
import query
import vault_writer

WEBHOOK_URL = "http://127.0.0.1:5678/webhook/mailhub/send"
def _load_mailhub_secret() -> str:
    """Secret aus der zentralen Secrets-Datei lesen (Rotation 03.08.2026, nicht mehr im Code)."""
    path = os.path.expanduser("~/.paperclip/instances/default/secrets/mailhub.env")
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if line.startswith("MAILHUB_SECRET="):
                return line.split("=", 1)[1].strip().strip('"')
    raise RuntimeError("MAILHUB_SECRET nicht gefunden in " + path)


MAILHUB_SECRET = _load_mailhub_secret()
FROM_ADDR = "cto@whitestag.ai"
TO_ADDR = "ws@whitestag.ai"
DIR = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(DIR, "state")


def hms(sec):
    sec = int(sec or 0)
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def fmt(n):
    return f"{int(n or 0):,}".replace(",", ".")


def build_html(day, rows, week_totals):
    total_calls = sum(r[1] for r in rows)
    total_tokens = sum(r[2] for r in rows)
    total_dur = sum(r[3] for r in rows)
    tag_kosten = sum(r[4] for r in rows if r[4] is not None)
    woche_kosten = sum(r[4] for r in week_totals if r[4] is not None)
    # Modelle ohne hinterlegten Preis kommen als eigene Zeile in die Mail —
    # sonst faellt eine fehlende Preiszeile still unter den Tisch und der
    # Report weist wieder zu wenig aus (genau die Luecke, die es zu schliessen galt).
    offen = pricing.unbekannte([r[0] for r in rows] + [r[0] for r in week_totals])

    day_rows = "".join(
        f"<tr><td style='padding:4px 10px'>{m}</td>"
        f"<td style='padding:4px 10px;text-align:right'>{fmt(c)}</td>"
        f"<td style='padding:4px 10px;text-align:right'>{fmt(t)}</td>"
        f"<td style='padding:4px 10px;text-align:right'>{hms(d)}</td>"
        f"<td style='padding:4px 10px;text-align:right'>{pricing.fmt_eur(k)}</td></tr>"
        for m, c, t, d, k in rows
    ) or "<tr><td colspan='5' style='padding:8px'>Keine Aufrufe an diesem Tag.</td></tr>"

    max_wk = max((c for _m, c, *_ in week_totals), default=1)
    week_rows = "".join(
        f"<tr><td style='padding:3px 10px'>{m}</td>"
        f"<td style='padding:3px 10px;text-align:right'>{fmt(c)}</td>"
        f"<td style='padding:3px 6px;width:200px'>"
        f"<div style='background:#1F3864;height:12px;border-radius:2px;"
        f"width:{max(2, round(200 * c / max_wk))}px'></div></td>"
        f"<td style='padding:3px 10px;text-align:right;color:#5f6368'>"
        f"{pricing.fmt_eur(k)}</td></tr>"
        for m, c, _t, _d, k in week_totals
    )

    hinweis = ""
    if offen:
        hinweis = (
            "<p style='background:#fce8e6;border-left:3px solid #d93025;"
            "padding:8px 12px;font-size:13px;margin-top:16px'>"
            "<b>Preis nicht hinterlegt:</b> " + ", ".join(offen) +
            " — diese Aufrufe fehlen in den Kostensummen. "
            "Preis in <code>pricing.py</code> ergänzen.</p>"
        )

    return f"""<!DOCTYPE html><html><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#202124;max-width:720px">
<h2 style="color:#1F3864;margin-bottom:2px">LLM-Nutzung — {day}</h2>
<p style="color:#5f6368;margin-top:0">Paperclip-Agenten · {fmt(total_calls)} Aufrufe · {fmt(total_tokens)} Token · Laufzeit {hms(total_dur)} · <b>Kosten {pricing.fmt_eur(tag_kosten)}</b></p>

<h3 style="color:#1F3864;margin-bottom:4px">Je Modell (Vortag)</h3>
<table style="border-collapse:collapse;font-size:14px;border:1px solid #dadce0">
<tr style="background:#1F3864;color:#fff">
<th style="padding:6px 10px;text-align:left">Modell</th>
<th style="padding:6px 10px;text-align:right">Aufrufe</th>
<th style="padding:6px 10px;text-align:right">Token</th>
<th style="padding:6px 10px;text-align:right">Laufzeit</th>
<th style="padding:6px 10px;text-align:right">Kosten</th></tr>
{day_rows}
<tr style="background:#f1f3f4;font-weight:bold">
<td style="padding:5px 10px">Summe</td>
<td style="padding:5px 10px;text-align:right">{fmt(total_calls)}</td>
<td style="padding:5px 10px;text-align:right">{fmt(total_tokens)}</td>
<td style="padding:5px 10px;text-align:right">{hms(total_dur)}</td>
<td style="padding:5px 10px;text-align:right">{pricing.fmt_eur(tag_kosten)}</td></tr>
</table>
{hinweis}

<h3 style="color:#1F3864;margin-bottom:4px;margin-top:24px">7 Tage — Aufrufe und Kosten je Modell</h3>
<table style="border-collapse:collapse;font-size:13px">
{week_rows}
<tr style="border-top:1px solid #dadce0;font-weight:bold">
<td style="padding:5px 10px">Summe 7 Tage</td>
<td style="padding:5px 10px;text-align:right">{fmt(sum(r[1] for r in week_totals))}</td>
<td></td>
<td style="padding:5px 10px;text-align:right">{pricing.fmt_eur(woche_kosten)}</td></tr>
</table>

<p style="color:#9aa0a6;font-size:12px;margin-top:24px">
Quelle: Paperclip <code>cost_events</code>. Nicht enthalten: n8n-AI-Nodes, PII-Proxy, LM-Studio-Direktnutzung, Claude Code.
Detail-Tabellen (LLM/Tag + Agent/Aufruf) mit Grafiken im angehängten Excel.<br>
<b>Kosten</b> sind aus den Token gerechnet (Preistabelle in <code>pricing.py</code>), nicht aus <code>cost_events.cost_cents</code> — Paperclip füllt die Spalte für Anthropic-Modelle nicht.
Lokale Modelle kosten 0 €. Cache-Reads zu 0,1× Input-Preis; Cache-<i>Writes</i> erfasst <code>cost_events</code> offenbar nicht getrennt, die echten Kosten liegen daher eher etwas höher.</p>
</body></html>"""


def build_attachment(day):
    os.makedirs(STATE, exist_ok=True)
    xlsx = os.path.join(STATE, f"LLM-Nutzung-{day}.xlsx")
    subprocess.run(
        [sys.executable, os.path.join(DIR, "build_xlsx.py"), "7", xlsx],
        check=True, cwd=DIR,
    )
    with open(xlsx, "rb") as f:
        content = base64.b64encode(f.read()).decode("ascii")
    return xlsx, {
        "filename": os.path.basename(xlsx),
        "content": content,
        "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }


def send(subject, html, attachments, dry):
    if dry:
        print(f"[dry-run] wuerde senden an {TO_ADDR}: {subject} "
              f"({len(attachments)} Anhang, {len(html)} bytes HTML)")
        return 0
    payload = json.dumps({
        "from": FROM_ADDR, "to": TO_ADDR, "subject": subject,
        "text": subject, "html": html, "attachments": attachments,
    }).encode("utf-8")
    req = urllib.request.Request(
        WEBHOOK_URL, data=payload,
        headers={"Content-Type": "application/json",
                 "X-Mailhub-Secret": MAILHUB_SECRET},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        print(f"gesendet ({resp.status}): {subject}")
    return 0


def main():
    day = None
    dry = False
    attach = True
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--day":
            day = args[i + 1]; i += 2
        elif args[i] == "--dry-run":
            dry = True; i += 1
        elif args[i] == "--no-attach":
            attach = False; i += 1
        else:
            print(f"unbekanntes Argument: {args[i]}", file=sys.stderr); sys.exit(1)
    if not day:
        day = query.yesterday_berlin()

    rows = query.per_llm_on_day(day)
    week_totals = query.totals_by_model(7)
    html = build_html(day, rows, week_totals)

    attachments = []
    if attach:
        _path, obj = build_attachment(day)
        attachments.append(obj)

    n_calls = sum(r[1] for r in rows)
    n_models = len(rows)
    kosten = sum(r[4] for r in rows if r[4] is not None)
    subject = (f"LLM-Nutzung {day} · {n_calls} Aufrufe / {n_models} Modelle"
               f" · {pricing.fmt_eur(kosten)}")
    rc = send(subject, html, attachments, dry)

    # Vault-Notiz NACH dem Versand und in try/except: der Mail-Spiegel im Vault
    # traegt nur den Betreff (send() setzt "text": subject), die Zahlen stehen
    # allein im HTML. Diese Notiz ist deshalb die einzige auswertbare Kopie —
    # aber sie darf den Versand unter keinen Umstaenden gefaehrden.
    if not dry:
        try:
            agent_rows = query.agent_model_on_day(day)
            notiz, _csv = vault_writer.schreibe_tag(
                date.fromisoformat(day), rows, agent_rows)
            print(f"Vault-Notiz: {notiz}" if notiz
                  else "Vault-Notiz: uebersprungen (keine Aufrufe)")
        except Exception as exc:  # noqa: BLE001 — Mail ist bereits raus
            print(f"WARNUNG: Vault-Notiz fehlgeschlagen: {exc}", file=sys.stderr)
    return rc


if __name__ == "__main__":
    sys.exit(main())
