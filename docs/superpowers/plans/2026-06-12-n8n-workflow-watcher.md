# n8n-Workflow-Wächter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein nächtlicher launchd-Job, der pro aktivem n8n-Workflow prüft, ob dessen jüngster Lauf fehlgeschlagen ist, und Walter nur bei Befund (plus wöchentlichem OK) eine Mail schickt.

**Architecture:** Eigenständiges Python-Stdlib-Script liest `~/.n8n/database.sqlite` read-only (WAL), bestimmt pro `active=1`-Workflow die jüngste Execution im 14-Tage-Fenster und flaggt `status IN ('error','crashed')`. Reine Funktionen (Detektion, Heartbeat-Entscheidung, Rendering) sind unit-getestet; DB-Zugriff und Mailversand sind dünn und gegen Fixtures/Mocks getestet. Versand über den bestehenden n8n-mailhub-Webhook.

**Tech Stack:** Python 3 (System-`/usr/bin/python3`), nur Stdlib (`sqlite3`, `urllib`, `json`, `html`, `datetime`, `argparse`), Tests mit `unittest`, Deployment via launchd-Plist.

---

## File Structure

| Datei | Verantwortung |
|---|---|
| `tools/n8n-workflow-watcher/n8n_workflow_watcher.py` | Komplettes Script: Konstanten, reine Funktionen, DB-Zugriff, Mailversand, `main()` |
| `tools/n8n-workflow-watcher/test_n8n_workflow_watcher.py` | `unittest`-Suite für alle reinen Funktionen + DB-Query gegen In-Memory-SQLite + Mail-Mock |
| `tools/n8n-workflow-watcher/ing.paperclip.n8n-workflow-watcher.plist` | launchd-Plist-Vorlage (täglich 03:30), wird nach `~/Library/LaunchAgents/` installiert |

**Laufzeit-Pfade (nicht im Repo, vom Script erzeugt):**
- State: `~/.paperclip/instances/default/state/n8n-workflow-watcher.json`
- App-Log: `~/.paperclip/instances/default/logs/n8n-workflow-watcher.log`
- launchd stdout/err: `~/Library/Logs/paperclip-n8n-watcher/`

**Hinweis zum Testlauf:** Alle Test-Kommandos werden aus dem Script-Verzeichnis ausgeführt:
`cd "tools/n8n-workflow-watcher"` (relativ zur Repo-Wurzel). Das Modul heißt `n8n_workflow_watcher` und wird im Test mit `import n8n_workflow_watcher as w` geladen.

---

## Task 1: Gerüst + Detektions-Funktion `find_failed_workflows`

**Files:**
- Create: `tools/n8n-workflow-watcher/n8n_workflow_watcher.py`
- Test: `tools/n8n-workflow-watcher/test_n8n_workflow_watcher.py`

- [ ] **Step 1: Failing test schreiben**

Create `tools/n8n-workflow-watcher/test_n8n_workflow_watcher.py`:

```python
import unittest
import n8n_workflow_watcher as w


class FindFailedWorkflows(unittest.TestCase):
    # row layout: (wf_id, name, mode, status, exec_id, started_at)
    def test_latest_error_is_flagged(self):
        rows = [("wf1", "Daily Digest", "trigger", "error", 455196, "2026-06-12 03:00:00")]
        out = w.find_failed_workflows(rows)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["id"], "wf1")
        self.assertEqual(out[0]["name"], "Daily Digest")
        self.assertEqual(out[0]["mode"], "trigger")
        self.assertEqual(out[0]["exec_id"], 455196)
        self.assertEqual(out[0]["failed_at"], "2026-06-12 03:00:00")

    def test_latest_crashed_is_flagged(self):
        rows = [("wf2", "RAG", "trigger", "crashed", 1, "2026-06-12 02:00:00")]
        self.assertEqual(len(w.find_failed_workflows(rows)), 1)

    def test_latest_success_not_flagged(self):
        rows = [("wf3", "E-Mails Clara V1", "trigger", "success", 456119, "2026-06-12 04:00:00")]
        self.assertEqual(w.find_failed_workflows(rows), [])

    def test_running_and_canceled_not_flagged(self):
        rows = [
            ("wf4", "X", "trigger", "running", 2, "2026-06-12 04:00:00"),
            ("wf5", "Y", "trigger", "canceled", 3, "2026-06-12 04:00:00"),
        ]
        self.assertEqual(w.find_failed_workflows(rows), [])

    def test_empty_rows(self):
        self.assertEqual(w.find_failed_workflows([]), [])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `cd "tools/n8n-workflow-watcher" && python3 -m unittest test_n8n_workflow_watcher -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'n8n_workflow_watcher'`

- [ ] **Step 3: Minimal-Implementierung (Kopf + Konstanten + Funktion)**

Create `tools/n8n-workflow-watcher/n8n_workflow_watcher.py`:

```python
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
```

- [ ] **Step 4: Test laufen lassen, Erfolg prüfen**

Run: `cd "tools/n8n-workflow-watcher" && python3 -m unittest test_n8n_workflow_watcher -v`
Expected: PASS (5 Tests)

- [ ] **Step 5: Commit**

```bash
git add "tools/n8n-workflow-watcher/n8n_workflow_watcher.py" "tools/n8n-workflow-watcher/test_n8n_workflow_watcher.py"
git commit -m "feat(n8n-watcher): scaffold + find_failed_workflows detection"
```

---

## Task 2: Heartbeat-Entscheidung `should_send_heartbeat`

**Files:**
- Modify: `tools/n8n-workflow-watcher/n8n_workflow_watcher.py`
- Test: `tools/n8n-workflow-watcher/test_n8n_workflow_watcher.py`

- [ ] **Step 1: Failing test schreiben** (an die Testdatei anhängen, vor dem `if __name__`-Block)

```python
from datetime import date


class ShouldSendHeartbeat(unittest.TestCase):
    MONDAY = date(2026, 6, 15)      # Montag
    TUESDAY = date(2026, 6, 16)     # Dienstag

    def test_monday_no_findings_overdue_true(self):
        self.assertTrue(w.should_send_heartbeat(self.MONDAY, "2026-06-08", has_findings=False))

    def test_monday_already_sent_today_false(self):
        self.assertFalse(w.should_send_heartbeat(self.MONDAY, "2026-06-15", has_findings=False))

    def test_monday_with_findings_false(self):
        self.assertFalse(w.should_send_heartbeat(self.MONDAY, "2026-06-08", has_findings=True))

    def test_non_monday_false(self):
        self.assertFalse(w.should_send_heartbeat(self.TUESDAY, "2026-06-01", has_findings=False))

    def test_monday_no_prior_heartbeat_true(self):
        self.assertTrue(w.should_send_heartbeat(self.MONDAY, None, has_findings=False))
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `cd "tools/n8n-workflow-watcher" && python3 -m unittest test_n8n_workflow_watcher.ShouldSendHeartbeat -v`
Expected: FAIL — `AttributeError: module 'n8n_workflow_watcher' has no attribute 'should_send_heartbeat'`

- [ ] **Step 3: Implementierung anhängen** (nach `find_failed_workflows`)

```python
def should_send_heartbeat(today, last_heartbeat_date, has_findings):
    """today: datetime.date. Montag(0) + kein Befund + Heartbeat heute noch nicht
    gesendet → True."""
    if has_findings:
        return False
    if today.weekday() != 0:  # 0 = Montag
        return False
    return last_heartbeat_date != today.isoformat()
```

- [ ] **Step 4: Test laufen lassen, Erfolg prüfen**

Run: `cd "tools/n8n-workflow-watcher" && python3 -m unittest test_n8n_workflow_watcher -v`
Expected: PASS (10 Tests)

- [ ] **Step 5: Commit**

```bash
git add "tools/n8n-workflow-watcher/n8n_workflow_watcher.py" "tools/n8n-workflow-watcher/test_n8n_workflow_watcher.py"
git commit -m "feat(n8n-watcher): weekly heartbeat decision"
```

---

## Task 3: Report-Rendering (Subject, Text, HTML, Execution-Link, Heartbeat)

**Files:**
- Modify: `tools/n8n-workflow-watcher/n8n_workflow_watcher.py`
- Test: `tools/n8n-workflow-watcher/test_n8n_workflow_watcher.py`

- [ ] **Step 1: Failing test schreiben** (anhängen)

```python
class Rendering(unittest.TestCase):
    FINDINGS = [
        {"id": "wfA", "name": "Paperclip Daily Digest V12", "mode": "trigger",
         "exec_id": 455196, "failed_at": "2026-06-12 03:00:00"},
        {"id": "wfB", "name": "Google-Alert V9 <x>", "mode": "trigger",
         "exec_id": 455607, "failed_at": "2026-06-12 02:30:00"},
    ]

    def test_subject_counts_findings(self):
        self.assertIn("2", w.build_subject(self.FINDINGS))

    def test_execution_url(self):
        self.assertEqual(
            w.execution_url("wfA", 455196),
            "http://localhost:5678/workflow/wfA/executions/455196",
        )

    def test_text_lists_each_finding(self):
        txt = w.render_report_text(self.FINDINGS)
        self.assertIn("Paperclip Daily Digest V12", txt)
        self.assertIn("455607", txt)

    def test_html_escapes_names_and_has_links(self):
        out = w.render_report_html(self.FINDINGS)
        self.assertIn("Google-Alert V9 &lt;x&gt;", out)        # escaped
        self.assertIn("/workflow/wfA/executions/455196", out)  # link
        self.assertIn("<table", out)

    def test_heartbeat_render(self):
        subject, text, html_body = w.render_heartbeat(23)
        self.assertIn("23", subject)
        self.assertIn("23", text)
        self.assertIn("23", html_body)
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `cd "tools/n8n-workflow-watcher" && python3 -m unittest test_n8n_workflow_watcher.Rendering -v`
Expected: FAIL — `AttributeError: ... has no attribute 'build_subject'`

- [ ] **Step 3: Implementierung anhängen**

```python
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
```

- [ ] **Step 4: Test laufen lassen, Erfolg prüfen**

Run: `cd "tools/n8n-workflow-watcher" && python3 -m unittest test_n8n_workflow_watcher -v`
Expected: PASS (15 Tests)

- [ ] **Step 5: Commit**

```bash
git add "tools/n8n-workflow-watcher/n8n_workflow_watcher.py" "tools/n8n-workflow-watcher/test_n8n_workflow_watcher.py"
git commit -m "feat(n8n-watcher): report + heartbeat rendering"
```

---

## Task 4: State laden/speichern

**Files:**
- Modify: `tools/n8n-workflow-watcher/n8n_workflow_watcher.py`
- Test: `tools/n8n-workflow-watcher/test_n8n_workflow_watcher.py`

- [ ] **Step 1: Failing test schreiben** (anhängen — nutzt ein temporäres Verzeichnis)

```python
import tempfile


class StateRoundTrip(unittest.TestCase):
    def test_missing_file_returns_empty(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(w.load_state(os.path.join(d, "nope.json")), {})

    def test_save_then_load(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "sub", "state.json")
            w.save_state({"last_heartbeat_date": "2026-06-15"}, path)
            self.assertEqual(w.load_state(path), {"last_heartbeat_date": "2026-06-15"})

    def test_corrupt_file_returns_empty(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "broken.json")
            with open(path, "w") as fh:
                fh.write("{not json")
            self.assertEqual(w.load_state(path), {})
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `cd "tools/n8n-workflow-watcher" && python3 -m unittest test_n8n_workflow_watcher.StateRoundTrip -v`
Expected: FAIL — `AttributeError: ... has no attribute 'load_state'`

- [ ] **Step 3: Implementierung anhängen**

```python
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
```

- [ ] **Step 4: Test laufen lassen, Erfolg prüfen**

Run: `cd "tools/n8n-workflow-watcher" && python3 -m unittest test_n8n_workflow_watcher -v`
Expected: PASS (18 Tests)

- [ ] **Step 5: Commit**

```bash
git add "tools/n8n-workflow-watcher/n8n_workflow_watcher.py" "tools/n8n-workflow-watcher/test_n8n_workflow_watcher.py"
git commit -m "feat(n8n-watcher): atomic state load/save"
```

---

## Task 5: DB-Query — jüngste Execution pro aktivem Workflow

**Files:**
- Modify: `tools/n8n-workflow-watcher/n8n_workflow_watcher.py`
- Test: `tools/n8n-workflow-watcher/test_n8n_workflow_watcher.py`

Diese Task testet gegen ein In-Memory-SQLite mit minimalem Schema. Die Query begrenzt
auf das 14-Tage-Fenster (`stoppedAt > datetime('now','-14 days')`, `deletedAt IS NULL`)
und nimmt pro Workflow die Execution mit dem größten `startedAt`; `_dedup_latest`
schützt gegen Timestamp-Kollisionen, indem es pro Workflow die größte `exec_id` behält.

- [ ] **Step 1: Failing test schreiben** (anhängen)

```python
class DbQuery(unittest.TestCase):
    def _make_db(self):
        conn = sqlite3.connect(":memory:")
        conn.executescript(
            """
            CREATE TABLE workflow_entity (id TEXT PRIMARY KEY, name TEXT, active INTEGER);
            CREATE TABLE execution_entity (
                id INTEGER PRIMARY KEY, workflowId TEXT, status TEXT, mode TEXT,
                startedAt TEXT, stoppedAt TEXT, deletedAt TEXT
            );
            """
        )
        conn.execute("INSERT INTO workflow_entity VALUES ('wf1','Digest',1)")
        conn.execute("INSERT INTO workflow_entity VALUES ('wf2','Clara',1)")
        conn.execute("INSERT INTO workflow_entity VALUES ('wf3','Inactive',0)")
        # wf1: latest is error
        conn.execute("INSERT INTO execution_entity VALUES "
                     "(10,'wf1','success','trigger',datetime('now','-3 hours'),"
                     "datetime('now','-3 hours'),NULL)")
        conn.execute("INSERT INTO execution_entity VALUES "
                     "(11,'wf1','error','trigger',datetime('now','-1 hours'),"
                     "datetime('now','-1 hours'),NULL)")
        # wf2: many old errors, latest success
        conn.execute("INSERT INTO execution_entity VALUES "
                     "(20,'wf2','error','trigger',datetime('now','-5 hours'),"
                     "datetime('now','-5 hours'),NULL)")
        conn.execute("INSERT INTO execution_entity VALUES "
                     "(21,'wf2','success','trigger',datetime('now','-2 hours'),"
                     "datetime('now','-2 hours'),NULL)")
        # wf3 inactive: should never appear
        conn.execute("INSERT INTO execution_entity VALUES "
                     "(30,'wf3','error','trigger',datetime('now','-1 hours'),"
                     "datetime('now','-1 hours'),NULL)")
        # out-of-window error for wf1 must not override
        conn.execute("INSERT INTO execution_entity VALUES "
                     "(40,'wf1','crashed','trigger',datetime('now','-30 days'),"
                     "datetime('now','-30 days'),NULL)")
        conn.commit()
        return conn

    def test_returns_latest_per_active_workflow(self):
        conn = self._make_db()
        rows = w._dedup_latest(w.fetch_active_workflow_latest(conn))
        by_id = {r[0]: r for r in rows}
        self.assertEqual(set(by_id), {"wf1", "wf2"})           # wf3 inactive excluded
        self.assertEqual(by_id["wf1"][3], "error")             # latest in-window status
        self.assertEqual(by_id["wf1"][4], 11)                  # exec_id 11, not the 30d-old 40
        self.assertEqual(by_id["wf2"][3], "success")

    def test_count_active(self):
        conn = self._make_db()
        self.assertEqual(w.count_active(conn), 2)

    def test_end_to_end_detection(self):
        conn = self._make_db()
        rows = w._dedup_latest(w.fetch_active_workflow_latest(conn))
        findings = w.find_failed_workflows(rows)
        self.assertEqual([f["id"] for f in findings], ["wf1"])
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `cd "tools/n8n-workflow-watcher" && python3 -m unittest test_n8n_workflow_watcher.DbQuery -v`
Expected: FAIL — `AttributeError: ... has no attribute 'fetch_active_workflow_latest'`

- [ ] **Step 3: Implementierung anhängen**

```python
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
```

- [ ] **Step 4: Test laufen lassen, Erfolg prüfen**

Run: `cd "tools/n8n-workflow-watcher" && python3 -m unittest test_n8n_workflow_watcher -v`
Expected: PASS (21 Tests)

- [ ] **Step 5: Commit**

```bash
git add "tools/n8n-workflow-watcher/n8n_workflow_watcher.py" "tools/n8n-workflow-watcher/test_n8n_workflow_watcher.py"
git commit -m "feat(n8n-watcher): read-only DB query for latest exec per active workflow"
```

---

## Task 6: Mailversand + Logging

**Files:**
- Modify: `tools/n8n-workflow-watcher/n8n_workflow_watcher.py`
- Test: `tools/n8n-workflow-watcher/test_n8n_workflow_watcher.py`

`send_mail` spiegelt den Deliverable-Watcher: POST an den mailhub-Webhook mit
`X-Mailhub-Secret`, Payload `{from,to,subject,text,html,attachments}`. Erfolg = HTTP 2xx.
Im Test wird `urllib.request.urlopen` gemockt.

- [ ] **Step 1: Failing test schreiben** (anhängen)

```python
from unittest import mock


class SendMail(unittest.TestCase):
    def test_posts_payload_and_returns_status(self):
        fake_resp = mock.MagicMock()
        fake_resp.status = 200
        fake_resp.__enter__.return_value = fake_resp
        with mock.patch.object(w.urllib.request, "urlopen", return_value=fake_resp) as uo:
            status = w.send_mail("Subj", "text body", "<p>html</p>", [])
        self.assertEqual(status, 200)
        req = uo.call_args.args[0]
        self.assertEqual(req.full_url, w.WEBHOOK_URL)
        self.assertEqual(req.get_header("X-mailhub-secret"), w.MAILHUB_SECRET)
        payload = json.loads(req.data.decode("utf-8"))
        self.assertEqual(payload["to"], w.TO_ADDR)
        self.assertEqual(payload["from"], w.FROM_ADDR)
        self.assertEqual(payload["subject"], "Subj")
        self.assertEqual(payload["html"], "<p>html</p>")

    def test_http_error_returns_code(self):
        err = w.urllib.error.HTTPError(w.WEBHOOK_URL, 500, "boom", {}, None)
        with mock.patch.object(w.urllib.request, "urlopen", side_effect=err):
            self.assertEqual(w.send_mail("s", "t", "", []), 500)
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `cd "tools/n8n-workflow-watcher" && python3 -m unittest test_n8n_workflow_watcher.SendMail -v`
Expected: FAIL — `AttributeError: ... has no attribute 'send_mail'`

- [ ] **Step 3: Implementierung anhängen**

```python
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
```

- [ ] **Step 4: Test laufen lassen, Erfolg prüfen**

Run: `cd "tools/n8n-workflow-watcher" && python3 -m unittest test_n8n_workflow_watcher -v`
Expected: PASS (23 Tests)

- [ ] **Step 5: Commit**

```bash
git add "tools/n8n-workflow-watcher/n8n_workflow_watcher.py" "tools/n8n-workflow-watcher/test_n8n_workflow_watcher.py"
git commit -m "feat(n8n-watcher): mailhub send + logging"
```

---

## Task 7: `main()` — Orchestrierung + CLI (`--once`, `--dry-run`, `--force`)

**Files:**
- Modify: `tools/n8n-workflow-watcher/n8n_workflow_watcher.py`
- Test: `tools/n8n-workflow-watcher/test_n8n_workflow_watcher.py`

`main()` öffnet die DB, holt die Findings, entscheidet Befund-Mail vs. Heartbeat,
respektiert Tages-Dedup (`last_run_date` + `last_reported_ids`) und schreibt State nur
bei erfolgreichem Versand (HTTP 2xx). In Tests werden `open_db_ro`/`count_active`/
`fetch_active_workflow_latest` sowie `send_mail` gepatcht; State zeigt auf eine Tempdatei.

- [ ] **Step 1: Failing test schreiben** (anhängen)

```python
class MainOrchestration(unittest.TestCase):
    def _patch_db(self, rows, active=23):
        # open_db_ro returns a sentinel; the fetch/count funcs are patched to ignore it
        return mock.patch.multiple(
            w,
            open_db_ro=mock.DEFAULT,
            fetch_active_workflow_latest=mock.DEFAULT,
            count_active=mock.DEFAULT,
            send_mail=mock.DEFAULT,
        )

    def test_findings_send_mail_and_persist(self):
        rows = [("wf1", "Digest", "trigger", "error", 11, "2026-06-12 03:00:00")]
        with tempfile.TemporaryDirectory() as d:
            statep = os.path.join(d, "state.json")
            with mock.patch.object(w, "STATE_PATH", statep), \
                 mock.patch.object(w, "open_db_ro", return_value=mock.MagicMock()), \
                 mock.patch.object(w, "fetch_active_workflow_latest", return_value=rows), \
                 mock.patch.object(w, "count_active", return_value=23), \
                 mock.patch.object(w, "send_mail", return_value=200) as sm:
                rc = w.main(["--once"])
        self.assertEqual(rc, 0)
        sm.assert_called_once()
        self.assertIn("1 Workflow", sm.call_args.args[0])     # subject
        state = w.load_state(statep)
        self.assertEqual(state["last_reported_ids"], ["wf1"])

    def test_findings_dry_run_does_not_send(self):
        rows = [("wf1", "Digest", "trigger", "error", 11, "2026-06-12 03:00:00")]
        with tempfile.TemporaryDirectory() as d:
            statep = os.path.join(d, "state.json")
            with mock.patch.object(w, "STATE_PATH", statep), \
                 mock.patch.object(w, "open_db_ro", return_value=mock.MagicMock()), \
                 mock.patch.object(w, "fetch_active_workflow_latest", return_value=rows), \
                 mock.patch.object(w, "count_active", return_value=23), \
                 mock.patch.object(w, "send_mail", return_value=200) as sm:
                rc = w.main(["--dry-run"])
        self.assertEqual(rc, 0)
        sm.assert_not_called()

    def test_no_findings_non_monday_silent(self):
        with tempfile.TemporaryDirectory() as d:
            statep = os.path.join(d, "state.json")
            with mock.patch.object(w, "STATE_PATH", statep), \
                 mock.patch.object(w, "open_db_ro", return_value=mock.MagicMock()), \
                 mock.patch.object(w, "fetch_active_workflow_latest", return_value=[]), \
                 mock.patch.object(w, "count_active", return_value=23), \
                 mock.patch.object(w, "should_send_heartbeat", return_value=False), \
                 mock.patch.object(w, "send_mail", return_value=200) as sm:
                rc = w.main(["--once"])
        self.assertEqual(rc, 0)
        sm.assert_not_called()

    def test_no_findings_heartbeat_due_sends(self):
        with tempfile.TemporaryDirectory() as d:
            statep = os.path.join(d, "state.json")
            with mock.patch.object(w, "STATE_PATH", statep), \
                 mock.patch.object(w, "open_db_ro", return_value=mock.MagicMock()), \
                 mock.patch.object(w, "fetch_active_workflow_latest", return_value=[]), \
                 mock.patch.object(w, "count_active", return_value=23), \
                 mock.patch.object(w, "should_send_heartbeat", return_value=True), \
                 mock.patch.object(w, "send_mail", return_value=200) as sm:
                rc = w.main(["--once"])
        self.assertEqual(rc, 0)
        sm.assert_called_once()
        self.assertIn("grün", sm.call_args.args[0])
        self.assertIn("last_heartbeat_date", w.load_state(statep))
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `cd "tools/n8n-workflow-watcher" && python3 -m unittest test_n8n_workflow_watcher.MainOrchestration -v`
Expected: FAIL — `AttributeError: ... has no attribute 'main'`

- [ ] **Step 3: Implementierung anhängen**

```python
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
    state = load_state()
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
            save_state(state)
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
            save_state(state)
            log("INFO", "heartbeat sent")
        else:
            log("ERROR", f"heartbeat failed http={status}")
    else:
        log("INFO", "no findings, no heartbeat due")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Test laufen lassen, Erfolg prüfen**

Run: `cd "tools/n8n-workflow-watcher" && python3 -m unittest test_n8n_workflow_watcher -v`
Expected: PASS (27 Tests)

- [ ] **Step 5: Commit**

```bash
git add "tools/n8n-workflow-watcher/n8n_workflow_watcher.py" "tools/n8n-workflow-watcher/test_n8n_workflow_watcher.py"
git commit -m "feat(n8n-watcher): main orchestration + CLI"
```

---

## Task 8: launchd-Plist + echte Dry-Run-Verifikation + Installation

**Files:**
- Create: `tools/n8n-workflow-watcher/ing.paperclip.n8n-workflow-watcher.plist`

- [ ] **Step 1: Plist-Vorlage schreiben**

Create `tools/n8n-workflow-watcher/ing.paperclip.n8n-workflow-watcher.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ing.paperclip.n8n-workflow-watcher</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/python3</string>
        <string>/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/Paperclip/tools/n8n-workflow-watcher/n8n_workflow_watcher.py</string>
        <string>--once</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>/Users/walterschoenenbroecher.de</string>
    </dict>

    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>3</integer>
        <key>Minute</key>
        <integer>30</integer>
    </dict>

    <key>RunAtLoad</key>
    <false/>

    <key>StandardOutPath</key>
    <string>/Users/walterschoenenbroecher.de/Library/Logs/paperclip-n8n-watcher/watcher.log</string>

    <key>StandardErrorPath</key>
    <string>/Users/walterschoenenbroecher.de/Library/Logs/paperclip-n8n-watcher/watcher.err.log</string>
</dict>
</plist>
```

- [ ] **Step 2: Gesamte Suite final grün**

Run: `cd "tools/n8n-workflow-watcher" && python3 -m unittest -v`
Expected: PASS (27 Tests, 0 failures)

- [ ] **Step 3: Echter Dry-Run gegen die Live-DB**

Run (aus der Repo-Wurzel):
`python3 "tools/n8n-workflow-watcher/n8n_workflow_watcher.py" --dry-run`
Expected: Gibt einen Subject + Tabelle/Liste aus. Auf Basis des Stands vom 2026-06-12
sollten u. a. `Paperclip Daily Digest V12` und `Google-Alert V9` als Befund erscheinen.
Es wird **keine** Mail versendet und **kein** State geschrieben.

- [ ] **Step 4: Plist installieren + Job laden**

```bash
mkdir -p ~/Library/Logs/paperclip-n8n-watcher
cp "tools/n8n-workflow-watcher/ing.paperclip.n8n-workflow-watcher.plist" ~/Library/LaunchAgents/
launchctl unload ~/Library/LaunchAgents/ing.paperclip.n8n-workflow-watcher.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/ing.paperclip.n8n-workflow-watcher.plist
launchctl list | grep n8n-workflow-watcher
```
Expected: Eine Zeile mit dem Label `ing.paperclip.n8n-workflow-watcher` erscheint.

- [ ] **Step 5: Einmal-Echtlauf erzwingen + Maileingang prüfen (mit Walter abstimmen)**

```bash
launchctl start ing.paperclip.n8n-workflow-watcher
tail -n 30 ~/.paperclip/instances/default/logs/n8n-workflow-watcher.log
```
Expected: Log zeigt `findings mail sent (N)`; eine Mail landet bei ws@whitestag.ai.
(Nur ausführen, wenn Walter den echten Versand jetzt testen will — sonst überspringen,
der 03:30-Lauf erledigt es.)

- [ ] **Step 6: Commit**

```bash
git add "tools/n8n-workflow-watcher/ing.paperclip.n8n-workflow-watcher.plist"
git commit -m "feat(n8n-watcher): launchd plist (nightly 03:30) + install"
```

---

## Self-Review

**Spec-Abdeckung:**
- Erkennungslogik (jüngster Run = error/crashed, 14-Tage-Fenster, keine Runs = kein Flag) → Task 1 + Task 5.
- Keine Stillstands-/Trend-Erkennung → durch Design der Query/Funktion erfüllt (nur jüngster Status).
- Walter-Mail via mailhub (from/to/secret) → Task 6.
- Nur-bei-Befund + wöchentliches OK (Montag) + Tages-Dedup → Task 2 + Task 7.
- Report-Inhalt (Name, Zeit, Modus, Execution-Link, HTML+Text, escaping) → Task 3.
- State-Datei → Task 4.
- launchd nachts 03:30, RunAtLoad false → Task 8.
- Edge Cases: DB nicht lesbar → `main` gibt 1 zurück (Task 7); `deletedAt` ausgeschlossen + Timestamp-Dedup (Task 5); n8n komplett tot = bewusste Grenze (kein Task nötig).
- Offene Spec-Punkte aufgelöst: Execution-URL-Form (`/workflow/<id>/executions/<execId>`, Task 3); Absender (FROM/TO aus Sibling, Task 6); SQL gegen Live-DB verifiziert (instant, deletedAt-Index).

**Placeholder-Scan:** Keine TBD/TODO; jeder Code-Step enthält vollständigen Code.

**Typ-Konsistenz:** Row-Layout `(wf_id, name, mode, status, exec_id, started_at)` einheitlich in Task 1/5/7. Finding-Keys `id/name/mode/exec_id/failed_at` einheitlich in Task 1/3/7. `send_mail(subject, text, html, attachments)`-Signatur einheitlich in Task 6/7.
