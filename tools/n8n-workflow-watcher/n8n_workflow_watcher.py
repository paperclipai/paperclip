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
    WHERE startedAt > datetime('now', ?) AND deletedAt IS NULL
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


def log(level, msg):
    line = f"{datetime.now().isoformat(timespec='seconds')} [{level}] {msg}"
    print(line, file=sys.stderr if level == "ERROR" else sys.stdout)
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def send_mail(subject, text_body, html_body, attachments):
    payload = {
        "from": FROM_ADDR,
        "to": TO_ADDR,
        "subject": subject,
        "text": text_body,
        "attachments": attachments or [],
    }
    if html_body:
        payload["html"] = html_body
    req = urllib.request.Request(
        WEBHOOK_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Mailhub-Secret": MAILHUB_SECRET},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status
    except urllib.error.HTTPError as e:
        log("ERROR", f"mailhub HTTP {e.code}")
        return e.code
    except Exception as e:  # noqa: BLE001
        log("ERROR", f"mailhub send failed: {e}")
        return 0


def _parse_args(argv):
    p = argparse.ArgumentParser(description="n8n-Workflow-Wächter")
    p.add_argument("--once", action="store_true",
                   help="Ein Durchlauf (Default-Verhalten; nur Parität zum Sibling)")
    p.add_argument("--dry-run", action="store_true", help="Rendern + loggen, nicht senden")
    p.add_argument("--force", action="store_true", help="Tages-Dedup ignorieren")
    return p.parse_args(argv)


def main(argv=None):
    args = _parse_args(argv)
    log("INFO", "run start")
    try:
        conn = open_db_ro()
    except sqlite3.Error as e:
        log("ERROR", f"DB open failed: {e}")
        return 1
    try:
        rows = _dedup_latest(fetch_active_workflow_latest(conn))
        active_count = count_active(conn)
    finally:
        conn.close()

    findings = find_failed_workflows(rows)
    state = load_state(STATE_PATH)
    today = datetime.now().date()
    today_iso = today.isoformat()

    if findings:
        ids = sorted(f["id"] for f in findings)
        dup = (state.get("last_run_date") == today_iso
               and state.get("last_reported_ids") == ids)
        if dup and not args.force:
            log("INFO", "findings already reported today; skipping")
            return 0
        subject = build_subject(findings)
        text = render_report_text(findings)
        html_body = render_report_html(findings)
        if args.dry_run:
            log("INFO", f"[dry-run] would send: {subject}")
            print(subject)
            print(text)
            return 0
        status = send_mail(subject, text, html_body, [])
        if 200 <= status < 300:
            state["last_run_date"] = today_iso
            state["last_reported_ids"] = ids
            save_state(state, STATE_PATH)
            log("INFO", f"findings mail sent ({len(findings)})")
        else:
            log("ERROR", f"findings mail failed http={status}")
        return 0

    # keine Findings → ggf. wöchentlicher Heartbeat
    if should_send_heartbeat(today, state.get("last_heartbeat_date"), False):
        subject, text, html_body = render_heartbeat(active_count)
        if args.dry_run:
            log("INFO", f"[dry-run] would send heartbeat: {subject}")
            print(subject)
            print(text)
            return 0
        status = send_mail(subject, text, html_body, [])
        if 200 <= status < 300:
            state["last_heartbeat_date"] = today_iso
            save_state(state, STATE_PATH)
            log("INFO", "heartbeat sent")
        else:
            log("ERROR", f"heartbeat failed http={status}")
    else:
        log("INFO", "no findings, no heartbeat due")
    return 0


if __name__ == "__main__":
    sys.exit(main())
