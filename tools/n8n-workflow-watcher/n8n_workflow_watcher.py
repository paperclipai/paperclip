#!/usr/bin/env python3
"""n8n-workflow-watcher.py — Nächtlicher Wächter über aktive n8n-Workflows.

Prüft pro Workflow mit active=1 den jüngsten Lauf im 14-Tage-Fenster und meldet
Walter per mailhub-Mail, wenn dieser Lauf fehlgeschlagen ist (status error/crashed).
Nur-bei-Befund + wöchentliches OK (Montag). Liest ~/.n8n/database.sqlite read-only.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime

HOME = os.path.expanduser("~")

# --- Konstanten ---------------------------------------------------------------
N8N_DB = os.path.join(HOME, ".n8n/database.sqlite")
N8N_BASE = "http://localhost:5678"
WINDOW_DAYS = 14
FAIL_STATUSES = {"error", "crashed"}

WEBHOOK_URL = "http://127.0.0.1:5678/webhook/mailhub/send"
MAILHUB_SECRET = "mailhub-812a27b07c73e64d7df192c98a3883eb"
TO_ADDR = "ws@whitestag.ai"
FROM_ADDR = "office@whitestag.ai"

STATE_PATH = os.path.join(HOME, ".paperclip/instances/default/state/n8n-workflow-watcher.json")
LOG_PATH = os.path.join(HOME, ".paperclip/instances/default/logs/n8n-workflow-watcher.log")


# --- Detektion (reine Funktion) ----------------------------------------------
def find_failed_workflows(rows):
    """rows: Iterable[(wf_id, name, mode, status, exec_id, started_at)].
    Gibt Findings zurück, deren status in FAIL_STATUSES liegt."""
    findings = []
    for wf_id, name, mode, status, exec_id, started_at in rows:
        if status in FAIL_STATUSES:
            findings.append({
                "id": wf_id,
                "name": name,
                "mode": mode,
                "exec_id": exec_id,
                "failed_at": started_at,
            })
    return findings


def should_send_heartbeat(today, last_heartbeat_date, has_findings):
    """today: datetime.date. Montag(0) + kein Befund + Heartbeat heute noch nicht
    gesendet → True."""
    if has_findings:
        return False
    if today.weekday() != 0:  # 0 = Montag
        return False
    return last_heartbeat_date != today.isoformat()


def build_subject(findings):
    return f"⚠️ n8n-Wächter: {len(findings)} Workflow(s) stehen auf Fehler"


def execution_url(wf_id, exec_id, base=N8N_BASE):
    return f"{base}/workflow/{wf_id}/executions/{exec_id}"


def render_report_text(findings, base=N8N_BASE):
    lines = ["Folgende aktive n8n-Workflows stehen auf Fehler "
             "(jüngster Lauf fehlgeschlagen):", ""]
    for f in findings:
        lines.append(
            f"- {f['name']}  |  {f['failed_at']}  |  {f['mode']}  |  "
            f"{execution_url(f['id'], f['exec_id'], base)}"
        )
    return "\n".join(lines)


def render_report_html(findings, base=N8N_BASE):
    body_rows = "".join(
        "<tr>"
        f"<td>{html.escape(str(f['name']))}</td>"
        f"<td>{html.escape(str(f['failed_at']))}</td>"
        f"<td>{html.escape(str(f['mode']))}</td>"
        f"<td><a href=\"{execution_url(f['id'], f['exec_id'], base)}\">"
        f"Execution {f['exec_id']}</a></td>"
        "</tr>"
        for f in findings
    )
    return (
        "<h2>n8n-Wächter</h2>"
        f"<p>{len(findings)} aktive Workflow(s) stehen auf Fehler "
        "(jüngster Lauf fehlgeschlagen):</p>"
        "<table border=\"1\" cellpadding=\"6\" cellspacing=\"0\">"
        "<tr><th>Workflow</th><th>Letzter Fehler</th><th>Modus</th><th>Execution</th></tr>"
        f"{body_rows}</table>"
    )


def render_heartbeat(active_count):
    subject = f"✅ n8n-Wächter: alle {active_count} aktiven Workflows grün"
    text = (f"Alle {active_count} aktiven n8n-Workflows sind grün "
            "(jüngster Lauf erfolgreich). Wächter läuft.")
    html_body = (f"<h2>✅ n8n-Wächter</h2><p>Alle {active_count} aktiven "
                 "Workflows grün (jüngster Lauf erfolgreich). Wächter läuft.</p>")
    return subject, text, html_body


def load_state(path=STATE_PATH):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(state, path=STATE_PATH):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(state, fh, indent=2)
    os.replace(tmp, path)


_LATEST_QUERY = """
SELECT w.id, w.name, e.mode, e.status, e.id, e.startedAt
FROM workflow_entity w
JOIN (
    SELECT workflowId, MAX(startedAt) AS ms
    FROM execution_entity
    WHERE stoppedAt > datetime('now', ?) AND deletedAt IS NULL
    GROUP BY workflowId
) m ON m.workflowId = w.id
JOIN execution_entity e
    ON e.workflowId = w.id AND e.startedAt = m.ms
WHERE w.active = 1
"""


def open_db_ro(path=N8N_DB):
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)


def fetch_active_workflow_latest(conn, window_days=WINDOW_DAYS):
    cur = conn.execute(_LATEST_QUERY, (f"-{window_days} days",))
    return cur.fetchall()


def _dedup_latest(rows):
    """Falls zwei Executions denselben startedAt haben: pro Workflow die mit der
    größten exec_id behalten. Spalten-Layout bleibt (wf_id,name,mode,status,exec_id,started)."""
    by_wf = {}
    for r in rows:
        wf_id, exec_id = r[0], r[4]
        prev = by_wf.get(wf_id)
        if prev is None or exec_id > prev[4]:
            by_wf[wf_id] = r
    return list(by_wf.values())


def count_active(conn):
    return conn.execute(
        "SELECT COUNT(*) FROM workflow_entity WHERE active = 1"
    ).fetchone()[0]
