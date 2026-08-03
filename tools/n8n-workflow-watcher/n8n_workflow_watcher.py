#!/usr/bin/env python3
"""n8n-workflow-watcher.py — Nächtlicher Wächter über aktive n8n-Workflows.

Prüft pro Workflow mit active=1 den jüngsten Lauf im 14-Tage-Fenster. Steht dieser
Lauf auf Fehler (status error/crashed), wird pro NEUER Execution (noch nicht in
state["reported_exec_ids"]) ein angereichertes Paperclip-Issue erstellt (idempotent),
zugewiesen an N8N_RECOVERY_AGENT_ID. Schlägt die API fehl, geht EINE Meta-Fallback-Mail
an Walter. Liest ~/.n8n/database.sqlite read-only.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime

import paperclip_client as pc
from n8n_execution_error import read_execution_error

HOME = os.path.expanduser("~")

# --- Konstanten ---------------------------------------------------------------
N8N_DB = os.path.join(HOME, ".n8n/database.sqlite")
N8N_BASE = "http://localhost:5678"
WINDOW_DAYS = 14
FAIL_STATUSES = {"error", "crashed"}

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
TO_ADDR = "ws@whitestag.ai"
FROM_ADDR = "office@whitestag.ai"

STATE_PATH = os.path.join(HOME, ".paperclip/instances/default/state/n8n-workflow-watcher.json")
LOG_PATH = os.path.join(HOME, ".paperclip/instances/default/logs/n8n-workflow-watcher.log")

COMPANY_ID = "9cebf3cf-efe8-4597-a400-f06488900a87"
RECOVERY_AGENT_ID = os.environ.get("N8N_RECOVERY_AGENT_ID", "")
PCP_BASE = os.environ.get("PCP_API", pc.DEFAULT_BASE)
PCP_TOKEN = os.environ.get("PCP_TOKEN", "") or pc.load_token()
REPORTED_CAP = 500  # reported_exec_ids-Liste begrenzen


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


def execution_url(wf_id, exec_id, base=N8N_BASE):
    return f"{base}/workflow/{wf_id}/executions/{exec_id}"


def new_findings(findings, reported_exec_ids):
    seen = set(reported_exec_ids or [])
    return [f for f in findings if f["exec_id"] not in seen]


def build_issue(finding, error_info):
    title = f"n8n-Fehler: {finding['name']} (Execution {finding['exec_id']})"
    url = execution_url(finding["id"], finding["exec_id"])
    msg = error_info.get("message") or "(keine Fehlermeldung in execution_data gefunden)"
    node = error_info.get("last_node") or error_info.get("node") or "?"
    http = error_info.get("http_code")
    lines = [
        f"**Workflow:** {finding['name']}  (`{finding['id']}`)",
        f"**Execution:** {finding['exec_id']}  —  **Modus:** {finding['mode']}",
        f"**Fehlgeschlagen:** {finding['failed_at']}",
        f"**Fehlerhafter Node:** {node}" + (f"  (HTTP {http})" if http else ""),
        "",
        "**Fehlermeldung:**",
        "```",
        msg,
        "```",
        "",
        f"Execution-Link: {url}",
        "",
        "_Automatisch erstellt vom n8n-Detektor. Diagnose/Klassifikation folgt durch "
        "den Diagnose-Agenten._",
    ]
    return title, "\n".join(lines)


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
    finally:
        conn.close()

    findings = find_failed_workflows(rows)
    state = load_state(STATE_PATH)
    reported = state.get("reported_exec_ids", [])

    fresh = new_findings(findings, reported)
    if not fresh:
        log("INFO", "keine neuen Fehler-Executions")
        return 0

    # execution_data je fresh-Finding lesen (eigene RO-Verbindung)
    conn2 = open_db_ro()
    try:
        for f in fresh:
            f["_error"] = read_execution_error(conn2, f["exec_id"])
    finally:
        conn2.close()

    if args.dry_run:
        for f in fresh:
            title, desc = build_issue(f, f["_error"])
            log("INFO", f"[dry-run] would create issue: {title}")
            print(title)
        return 0

    created, failed = [], 0
    for f in fresh:
        title, desc = build_issue(f, f["_error"])
        try:
            issue_id = pc.create_issue(
                PCP_BASE, PCP_TOKEN, COMPANY_ID,
                title=title, description=desc,
                assignee_agent_id=RECOVERY_AGENT_ID or None,
                priority="high")
        except pc.ApiError as e:
            failed += 1
            log("ERROR", f"issue-create fehlgeschlagen exec {f['exec_id']}: {e}")
            continue
        if not issue_id:
            failed += 1
            log("ERROR", f"issue-create lieferte keine id für exec {f['exec_id']}")
            continue
        created.append(f["exec_id"])
        log("INFO", f"issue {issue_id} erstellt für exec {f['exec_id']}")

    if created:
        merged = (reported + created)[-REPORTED_CAP:]
        state["reported_exec_ids"] = merged
        save_state(state, STATE_PATH)

    if failed:
        subject = "⚠️ n8n-Wächter: Issue-Erstellung fehlgeschlagen (API?)"
        body = (f"{failed} von {len(fresh)} Fehler-Issue(s) konnten nicht in Paperclip "
                f"angelegt werden. Bitte Control-Plane (:3100) prüfen.")
        send_mail(subject, body, "", [])
    return 0


if __name__ == "__main__":
    sys.exit(main())
