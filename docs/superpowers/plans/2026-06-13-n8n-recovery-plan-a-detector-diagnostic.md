# n8n Auto-Recovery — Plan A: Detektor → diagnostizierte Issues + Diagnose-Agent (read-only)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fehlgeschlagene aktive n8n-Workflows werden nächtlich zu **diagnostizierten Paperclip-Issues** (statt einer Sammel-Mail), zugewiesen an einen neuen **read-only Diagnose-Agenten** unter dem CTO, der Root Cause klassifiziert, einen Nacht-Report-Rollup pflegt und Unklares an den CTO eskaliert.

**Architecture:** Der bestehende Python-Wächter (`tools/n8n-workflow-watcher/`) bleibt der launchd-getriggerte Detektor (03:30), erstellt aber pro **neuem** Fehler-Execution ein Paperclip-Issue (idempotent über `exec_id`), angereichert mit der aus `execution_data` extrahierten Fehlermeldung. Ein neuer `claude_local`-Agent „n8n-Betriebsingenieur" wird durch die Issue-Zuweisung per Task-Wake geweckt und arbeitet **strikt read-only**: Diagnose + Klassifikation als Kommentar, Rollup-Issue „n8n Ops `<Datum>`", Eskalation als Subtask. Mutierende Reparatur (CLI-Toolkit, grün/rot, Approvals) ist **Plan B**.

**Tech Stack:** Python 3 (stdlib only: `sqlite3`, `urllib`, `json`), `unittest`/`pytest`, Paperclip Control-Plane REST (`:3100`), n8n sqlite (`~/.n8n/database.sqlite`, read-only), claude_local-Adapter, launchd.

**Vorab fixierte Live-Fakten (verifiziert 2026-06-13):**
- Company WHITESTAG: `9cebf3cf-efe8-4597-a400-f06488900a87`
- CTO-Agent (reportsTo-Ziel): `5b7cb8a7-945f-4861-b3a7-4ae84d242d1e`
- Board-Token: `auth.json` → `credentials["http://localhost:3100"]["token"]`
- Issue anlegen: `POST /api/companies/{cid}/issues` — Pflicht `title`; optional `description`, `assigneeAgentId`, `priority` (low|medium|high), `parentId`. Auth: `Authorization: Bearer <token>`.
- Kommentar: `POST /api/issues/{id}/comments` — Pflicht `body`.
- Agent-Hire: `POST /api/companies/{cid}/agent-hires` — Pflicht `name`, `adapterType`; optional `reportsTo`, `adapterConfig`, `capabilities`, `budgetMonthlyCents`, `role`, `instructionsBundle{files,entryFile}`. Approval-Gate aktiv → danach `POST /api/approvals/{id}/approve`.
- Nächtlicher Instructions-Generator: `~/.paperclip/scripts/agents-instructions/build_manifest.py`, `EXCLUDE_NAMES`-Set steuert, welche Agenten **nicht** automatisch überschrieben werden.
- Detektor läuft unter `/usr/bin/python3` (System-Python, **keine** Drittpakete erlaubt).

---

## File Structure

- `tools/n8n-workflow-watcher/n8n_execution_error.py` — **neu**: tolerantes Extrahieren von Fehlerdetails aus `execution_data`.
- `tools/n8n-workflow-watcher/test_n8n_execution_error.py` — **neu**: Tests dazu.
- `tools/n8n-workflow-watcher/paperclip_client.py` — **neu**: dünner Paperclip-REST-Client (Token laden, Issue anlegen, Kommentar).
- `tools/n8n-workflow-watcher/test_paperclip_client.py` — **neu**: Tests dazu.
- `tools/n8n-workflow-watcher/n8n_workflow_watcher.py` — **ändern**: `main()` erstellt Issues statt Sammel-Mail; Idempotenz über `reported_exec_ids`; Meta-Fallback-Mail nur bei API-Ausfall; Heartbeat-Mail entfällt.
- `tools/n8n-workflow-watcher/test_n8n_workflow_watcher.py` — **ändern**: neue Tests, angepasste `MainOrchestration`-Tests.
- `tools/n8n-workflow-watcher/ing.paperclip.n8n-workflow-watcher.plist` — **ändern**: `EnvironmentVariables` mit `N8N_RECOVERY_AGENT_ID` + `PCP_TOKEN`-Quelle.
- `tools/n8n-workflow-watcher/DEPLOY.md` — **ändern**: drei Dateien deployen, neue Env-Vars dokumentieren.
- `tools/n8n-workflow-watcher/agent/AGENTS.md` — **neu**: read-only Playbook/Instructions des Diagnose-Agenten.
- `~/.paperclip/scripts/agents-instructions/build_manifest.py` — **ändern**: Agent-Name zu `EXCLUDE_NAMES`.

---

## Task 1: Fehlerdetails aus `execution_data` extrahieren

**Files:**
- Create: `tools/n8n-workflow-watcher/n8n_execution_error.py`
- Test: `tools/n8n-workflow-watcher/test_n8n_execution_error.py`

Hintergrund: `execution_data.data` ist ein JSON-**Array** im n8n-Dedup/Flatted-Format. Die Fehler-Indizes variieren je Version, daher **kein** Hardcoding von Index `[5]`/`[2]`, sondern tolerantes Scannen: das Fehlerobjekt ist das Dict mit `message` **und** (`stack` oder `name`); `lastNodeExecuted` wird separat gescannt (Wert kann String-Name oder Array-Index sein).

- [ ] **Step 1: Failing Test schreiben**

```python
# test_n8n_execution_error.py
import json
import sqlite3
import unittest
import n8n_execution_error as ee


# Repräsentatives n8n-Dedup-Array (vereinfacht, an Live-Struktur angelehnt):
# - data[2] referenziert error-Index + lastNodeExecuted (String)
# - data[5] ist das Fehlerobjekt
SAMPLE = json.dumps([
    {"resultData": 2},
    {},
    {"error": 5, "runData": 1, "lastNodeExecuted": "OpenAI Chat Model"},
    {},
    {},
    {"level": "error", "name": "NodeApiError",
     "message": "Bad request - please check your parameters",
     "httpCode": "400", "node": "OpenAI Chat Model",
     "stack": "NodeApiError: Bad request\n    at AsyncCaller.onFailedAttempt"},
])


class ExtractError(unittest.TestCase):
    def test_extracts_message_node_httpcode(self):
        out = ee.extract_error(SAMPLE)
        self.assertEqual(out["message"], "Bad request - please check your parameters")
        self.assertEqual(out["node"], "OpenAI Chat Model")
        self.assertEqual(out["http_code"], "400")
        self.assertEqual(out["name"], "NodeApiError")
        self.assertIn("NodeApiError: Bad request", out["stack_excerpt"])

    def test_last_node_executed_string(self):
        out = ee.extract_error(SAMPLE)
        self.assertEqual(out["last_node"], "OpenAI Chat Model")

    def test_garbage_does_not_crash(self):
        out = ee.extract_error("{not valid json")
        self.assertEqual(out["message"], "")
        self.assertEqual(out["node"], "")
        self.assertEqual(out["stack_excerpt"], "")

    def test_empty_array(self):
        out = ee.extract_error("[]")
        self.assertEqual(out["message"], "")

    def test_stack_excerpt_truncated(self):
        big = json.dumps([{"message": "x", "name": "E", "stack": "S" * 5000}])
        out = ee.extract_error(big)
        self.assertLessEqual(len(out["stack_excerpt"]), 1200)


class ReadExecutionError(unittest.TestCase):
    def _db(self):
        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE TABLE execution_data (executionId INT PRIMARY KEY, "
                     "workflowData TEXT, data TEXT, workflowVersionId TEXT)")
        conn.execute("INSERT INTO execution_data VALUES (447224, '{}', ?, 'v1')", (SAMPLE,))
        conn.commit()
        return conn

    def test_reads_and_extracts(self):
        conn = self._db()
        out = ee.read_execution_error(conn, 447224)
        self.assertEqual(out["http_code"], "400")

    def test_missing_execution_returns_empty(self):
        conn = self._db()
        out = ee.read_execution_error(conn, 999999)
        self.assertEqual(out["message"], "")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd tools/n8n-workflow-watcher && python3 -m pytest test_n8n_execution_error.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'n8n_execution_error'`

- [ ] **Step 3: Minimale Implementierung schreiben**

```python
# n8n_execution_error.py
"""Tolerantes Extrahieren von Fehlerdetails aus n8n execution_data.data
(JSON-Dedup-Array). Bricht nie ab — bei Unklarheit leere Felder."""
from __future__ import annotations

import json

_EMPTY = {"message": "", "node": "", "http_code": "", "name": "",
          "stack_excerpt": "", "last_node": ""}
_STACK_MAX = 1200


def _find_error_obj(items):
    """Erstes Dict mit 'message' UND ('stack' oder 'name') gilt als Fehlerobjekt."""
    for it in items:
        if isinstance(it, dict) and "message" in it and ("stack" in it or "name" in it):
            return it
    return None


def _find_last_node(items):
    for it in items:
        if isinstance(it, dict) and "lastNodeExecuted" in it:
            v = it["lastNodeExecuted"]
            if isinstance(v, str):
                return v
            if isinstance(v, int) and 0 <= v < len(items) and isinstance(items[v], str):
                return items[v]
    return ""


def extract_error(data_json: str) -> dict:
    out = dict(_EMPTY)
    try:
        items = json.loads(data_json)
    except (ValueError, TypeError):
        return out
    if not isinstance(items, list):
        return out
    err = _find_error_obj(items)
    if err:
        out["message"] = str(err.get("message", ""))
        out["node"] = str(err.get("node", ""))
        out["http_code"] = str(err.get("httpCode", ""))
        out["name"] = str(err.get("name", ""))
        out["stack_excerpt"] = str(err.get("stack", ""))[:_STACK_MAX]
    out["last_node"] = _find_last_node(items) or out["node"]
    return out


def read_execution_error(conn, exec_id) -> dict:
    """Liest execution_data.data für exec_id und extrahiert die Fehlerdetails."""
    row = conn.execute(
        "SELECT data FROM execution_data WHERE executionId = ?", (exec_id,)
    ).fetchone()
    if not row or not row[0]:
        return dict(_EMPTY)
    return extract_error(row[0])
```

- [ ] **Step 4: Test laufen lassen, Erfolg bestätigen**

Run: `cd tools/n8n-workflow-watcher && python3 -m pytest test_n8n_execution_error.py -v`
Expected: PASS (alle 7 Tests)

- [ ] **Step 5: Commit**

```bash
git add tools/n8n-workflow-watcher/n8n_execution_error.py tools/n8n-workflow-watcher/test_n8n_execution_error.py
git commit -m "feat(n8n-recovery): tolerant execution_data error extractor"
```

---

## Task 2: Paperclip-REST-Client

**Files:**
- Create: `tools/n8n-workflow-watcher/paperclip_client.py`
- Test: `tools/n8n-workflow-watcher/test_paperclip_client.py`

- [ ] **Step 1: Failing Test schreiben**

```python
# test_paperclip_client.py
import json
import os
import tempfile
import unittest
from unittest import mock
import paperclip_client as pc

AUTH = {"version": 1, "credentials": {
    "http://localhost:3100": {"apiBase": "http://localhost:3100",
                              "token": "tok-abc-123", "userId": "u1"}}}


class LoadToken(unittest.TestCase):
    def test_loads_nested_token(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "auth.json")
            with open(p, "w") as fh:
                json.dump(AUTH, fh)
            self.assertEqual(pc.load_token(p), "tok-abc-123")

    def test_missing_file_returns_empty(self):
        self.assertEqual(pc.load_token("/no/such/auth.json"), "")


class CreateIssue(unittest.TestCase):
    def test_posts_issue_and_returns_id(self):
        resp = mock.MagicMock()
        resp.status = 201
        resp.read.return_value = json.dumps({"id": "issue-1"}).encode()
        resp.__enter__.return_value = resp
        with mock.patch.object(pc.urllib.request, "urlopen", return_value=resp) as uo:
            issue_id = pc.create_issue(
                "http://localhost:3100", "tok", "cid-1",
                title="T", description="D",
                assignee_agent_id="agent-9", priority="high")
        self.assertEqual(issue_id, "issue-1")
        req = uo.call_args.args[0]
        self.assertEqual(req.full_url, "http://localhost:3100/api/companies/cid-1/issues")
        self.assertEqual(req.get_header("Authorization"), "Bearer tok")
        body = json.loads(req.data.decode())
        self.assertEqual(body["title"], "T")
        self.assertEqual(body["assigneeAgentId"], "agent-9")
        self.assertEqual(body["priority"], "high")

    def test_omits_assignee_when_none(self):
        resp = mock.MagicMock()
        resp.status = 201
        resp.read.return_value = json.dumps({"id": "issue-2"}).encode()
        resp.__enter__.return_value = resp
        with mock.patch.object(pc.urllib.request, "urlopen", return_value=resp) as uo:
            pc.create_issue("http://localhost:3100", "tok", "cid-1",
                            title="T", description="D",
                            assignee_agent_id=None, priority="medium")
        body = json.loads(uo.call_args.args[0].data.decode())
        self.assertNotIn("assigneeAgentId", body)

    def test_http_error_raises_apierror(self):
        err = pc.urllib.error.HTTPError("u", 400, "bad", {}, None)
        with mock.patch.object(pc.urllib.request, "urlopen", side_effect=err):
            with self.assertRaises(pc.ApiError):
                pc.create_issue("http://localhost:3100", "tok", "cid-1",
                                title="T", description="D",
                                assignee_agent_id=None, priority="medium")


class AddComment(unittest.TestCase):
    def test_posts_comment(self):
        resp = mock.MagicMock()
        resp.status = 201
        resp.read.return_value = b"{}"
        resp.__enter__.return_value = resp
        with mock.patch.object(pc.urllib.request, "urlopen", return_value=resp) as uo:
            pc.add_comment("http://localhost:3100", "tok", "issue-1", "hello")
        req = uo.call_args.args[0]
        self.assertEqual(req.full_url, "http://localhost:3100/api/issues/issue-1/comments")
        self.assertEqual(json.loads(req.data.decode())["body"], "hello")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd tools/n8n-workflow-watcher && python3 -m pytest test_paperclip_client.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'paperclip_client'`

- [ ] **Step 3: Minimale Implementierung schreiben**

```python
# paperclip_client.py
"""Dünner, stdlib-only Client für die Paperclip Control-Plane (:3100)."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

DEFAULT_BASE = "http://localhost:3100"


class ApiError(RuntimeError):
    pass


def load_token(auth_path: str | None = None) -> str:
    auth_path = auth_path or os.path.expanduser("~/.paperclip/auth.json")
    try:
        with open(auth_path) as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return ""
    creds = (data or {}).get("credentials", {})
    entry = creds.get(DEFAULT_BASE) or creds.get("http://127.0.0.1:3100") or {}
    return entry.get("token", "")


def _post(url: str, token: str, payload: dict) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode("utf-8") or "{}"
            return json.loads(raw)
    except urllib.error.HTTPError as e:
        raise ApiError(f"HTTP {e.code} for {url}") from e
    except Exception as e:  # noqa: BLE001
        raise ApiError(f"request failed for {url}: {e}") from e


def create_issue(base: str, token: str, company_id: str, *, title: str,
                 description: str, assignee_agent_id: str | None,
                 priority: str = "medium", parent_id: str | None = None) -> str:
    payload = {"title": title, "description": description, "priority": priority}
    if assignee_agent_id:
        payload["assigneeAgentId"] = assignee_agent_id
    if parent_id:
        payload["parentId"] = parent_id
    out = _post(f"{base}/api/companies/{company_id}/issues", token, payload)
    return out.get("id", "")


def add_comment(base: str, token: str, issue_id: str, body: str) -> None:
    _post(f"{base}/api/issues/{issue_id}/comments", token, {"body": body})
```

- [ ] **Step 4: Test laufen lassen, Erfolg bestätigen**

Run: `cd tools/n8n-workflow-watcher && python3 -m pytest test_paperclip_client.py -v`
Expected: PASS (alle 6 Tests)

- [ ] **Step 5: Commit**

```bash
git add tools/n8n-workflow-watcher/paperclip_client.py tools/n8n-workflow-watcher/test_paperclip_client.py
git commit -m "feat(n8n-recovery): stdlib Paperclip REST client (issues + comments)"
```

---

## Task 3: Detektor auf Issue-Erstellung umstellen (Idempotenz + Meta-Fallback)

**Files:**
- Modify: `tools/n8n-workflow-watcher/n8n_workflow_watcher.py`
- Modify: `tools/n8n-workflow-watcher/test_n8n_workflow_watcher.py`

Verhalten neu: bei Findings wird pro **neuem** `exec_id` (nicht in `state["reported_exec_ids"]`) ein Issue erstellt, angereichert mit den Fehlerdetails aus `execution_data`, zugewiesen an `N8N_RECOVERY_AGENT_ID` (aus Env; falls leer → unassigned/backlog). Bei API-Ausfall → **eine** Meta-Fallback-Mail (Reuse `send_mail`). Die wöchentliche „alles grün"-Mail entfällt (Report lebt künftig in Paperclip, Plan B).

- [ ] **Step 1: Failing Tests schreiben** (an `test_n8n_workflow_watcher.py` anhängen)

```python
# --- NEU: Issue-Pfad ---------------------------------------------------------
class NewFindings(unittest.TestCase):
    def test_filters_already_reported_exec_ids(self):
        findings = [
            {"id": "wf1", "name": "A", "mode": "trigger", "exec_id": 11, "failed_at": "t"},
            {"id": "wf2", "name": "B", "mode": "trigger", "exec_id": 22, "failed_at": "t"},
        ]
        out = w.new_findings(findings, reported_exec_ids=[11])
        self.assertEqual([f["exec_id"] for f in out], [22])

    def test_all_new_when_state_empty(self):
        findings = [{"id": "wf1", "name": "A", "mode": "trigger",
                     "exec_id": 11, "failed_at": "t"}]
        self.assertEqual(len(w.new_findings(findings, [])), 1)


class BuildIssue(unittest.TestCase):
    FINDING = {"id": "wfA", "name": "Daily Digest V12", "mode": "trigger",
               "exec_id": 455196, "failed_at": "2026-06-12 03:00:00"}
    ERR = {"message": "Bad request", "node": "OpenAI Chat Model", "http_code": "400",
           "name": "NodeApiError", "stack_excerpt": "NodeApiError: Bad request",
           "last_node": "OpenAI Chat Model"}

    def test_title_has_workflow_name(self):
        title, _ = w.build_issue(self.FINDING, self.ERR)
        self.assertIn("Daily Digest V12", title)

    def test_description_has_error_and_link(self):
        _, desc = w.build_issue(self.FINDING, self.ERR)
        self.assertIn("Bad request", desc)
        self.assertIn("OpenAI Chat Model", desc)
        self.assertIn("455196", desc)
        self.assertIn("/workflow/wfA/executions/455196", desc)

    def test_handles_empty_error(self):
        empty = {"message": "", "node": "", "http_code": "", "name": "",
                 "stack_excerpt": "", "last_node": ""}
        title, desc = w.build_issue(self.FINDING, empty)
        self.assertIn("Daily Digest V12", title)
        self.assertIn("455196", desc)


class MainCreatesIssues(unittest.TestCase):
    def setUp(self):
        _isolate_log(self)

    def _patches(self, rows, statep):
        return [
            mock.patch.object(w, "STATE_PATH", statep),
            mock.patch.object(w, "open_db_ro", return_value=mock.MagicMock()),
            mock.patch.object(w, "fetch_active_workflow_latest", return_value=rows),
            mock.patch.object(w, "count_active", return_value=23),
            mock.patch.object(w, "read_execution_error",
                              return_value={"message": "Boom", "node": "N", "http_code": "",
                                            "name": "E", "stack_excerpt": "", "last_node": "N"}),
            mock.patch.object(w, "RECOVERY_AGENT_ID", "agent-9"),
            mock.patch.object(w, "PCP_TOKEN", "tok"),
        ]

    def test_creates_one_issue_per_new_finding(self):
        rows = [("wf1", "Digest", "trigger", "error", 11, "2026-06-12 03:00:00")]
        with tempfile.TemporaryDirectory() as d:
            statep = os.path.join(d, "state.json")
            ctx = self._patches(rows, statep)
            with ctx[0], ctx[1], ctx[2], ctx[3], ctx[4], ctx[5], ctx[6], \
                 mock.patch.object(w.pc, "create_issue", return_value="issue-1") as ci, \
                 mock.patch.object(w, "send_mail") as sm:
                rc = w.main(["--once"])
            self.assertEqual(rc, 0)
            ci.assert_called_once()
            self.assertEqual(ci.call_args.kwargs["assignee_agent_id"], "agent-9")
            sm.assert_not_called()
            self.assertIn(11, w.load_state(statep)["reported_exec_ids"])

    def test_idempotent_no_duplicate_issue(self):
        rows = [("wf1", "Digest", "trigger", "error", 11, "2026-06-12 03:00:00")]
        with tempfile.TemporaryDirectory() as d:
            statep = os.path.join(d, "state.json")
            w.save_state({"reported_exec_ids": [11]}, statep)
            ctx = self._patches(rows, statep)
            with ctx[0], ctx[1], ctx[2], ctx[3], ctx[4], ctx[5], ctx[6], \
                 mock.patch.object(w.pc, "create_issue", return_value="issue-1") as ci:
                rc = w.main(["--once"])
            self.assertEqual(rc, 0)
            ci.assert_not_called()

    def test_api_failure_triggers_meta_fallback_mail(self):
        rows = [("wf1", "Digest", "trigger", "error", 11, "2026-06-12 03:00:00")]
        with tempfile.TemporaryDirectory() as d:
            statep = os.path.join(d, "state.json")
            ctx = self._patches(rows, statep)
            with ctx[0], ctx[1], ctx[2], ctx[3], ctx[4], ctx[5], ctx[6], \
                 mock.patch.object(w.pc, "create_issue",
                                   side_effect=w.pc.ApiError("HTTP 500")), \
                 mock.patch.object(w, "send_mail", return_value=200) as sm:
                rc = w.main(["--once"])
            self.assertEqual(rc, 0)
            sm.assert_called_once()
            self.assertIn("Wächter", sm.call_args.args[0])
            # exec_id NICHT als gemeldet markiert, damit nächster Lauf erneut versucht
            self.assertNotIn(11, w.load_state(statep).get("reported_exec_ids", []))
```

Außerdem die **veralteten** Mail-orientierten Tests in `MainOrchestration` entfernen
(`test_findings_send_mail_and_persist`, `test_no_findings_heartbeat_due_sends`) — der
Findings-Pfad mailt nicht mehr, der wöchentliche Heartbeat entfällt. `test_findings_dry_run_does_not_send`
und `test_no_findings_non_monday_silent` bleiben sinngemäß (siehe Step 3-Anpassung von `main`).

- [ ] **Step 2: Tests laufen lassen, Fehlschlag bestätigen**

Run: `cd tools/n8n-workflow-watcher && python3 -m pytest test_n8n_workflow_watcher.py -v`
Expected: FAIL — `AttributeError: module ... has no attribute 'new_findings'` (bzw. `build_issue`, `read_execution_error`, `pc`, `RECOVERY_AGENT_ID`)

- [ ] **Step 3: Implementierung in `n8n_workflow_watcher.py`**

Imports + Konstanten oben ergänzen (nach den bestehenden Konstanten):

```python
import paperclip_client as pc
from n8n_execution_error import read_execution_error

COMPANY_ID = "9cebf3cf-efe8-4597-a400-f06488900a87"
RECOVERY_AGENT_ID = os.environ.get("N8N_RECOVERY_AGENT_ID", "")
PCP_BASE = os.environ.get("PCP_API", pc.DEFAULT_BASE)
PCP_TOKEN = os.environ.get("PCP_TOKEN", "") or pc.load_token()
REPORTED_CAP = 500  # reported_exec_ids-Liste begrenzen
```

Neue reine Funktionen (neben den bestehenden Renderern):

```python
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
```

`main()` umbauen — den bisherigen Findings-Block (Mail) ersetzen durch:

```python
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
            created.append(f["exec_id"])
            log("INFO", f"issue {issue_id} erstellt für exec {f['exec_id']}")
        except pc.ApiError as e:
            failed += 1
            log("ERROR", f"issue-create fehlgeschlagen exec {f['exec_id']}: {e}")

    if created:
        merged = (reported + created)[-REPORTED_CAP:]
        state["reported_exec_ids"] = merged
        state["last_run_date"] = today_iso
        save_state(state, STATE_PATH)

    if failed:
        # Meta-Monitoring: API teilweise/ganz nicht erreichbar → eine Fallback-Mail
        subject = "⚠️ n8n-Wächter: Issue-Erstellung fehlgeschlagen (API?)"
        body = (f"{failed} von {len(fresh)} Fehler-Issue(s) konnten nicht in Paperclip "
                f"angelegt werden. Bitte Control-Plane (:3100) prüfen.")
        send_mail(subject, body, "", [])
    return 0
```

Den bisherigen Heartbeat-Block (`should_send_heartbeat` … wöchentliche Mail) **entfernen**.
`should_send_heartbeat`/`render_heartbeat` können als ungenutzt entfernt werden; ihre Tests
ebenfalls (siehe Step 1).

- [ ] **Step 4: Tests laufen lassen, Erfolg bestätigen**

Run: `cd tools/n8n-workflow-watcher && python3 -m pytest -v`
Expected: PASS (alle Dateien; entfernte Heartbeat-Tests sind weg)

- [ ] **Step 5: Commit**

```bash
git add tools/n8n-workflow-watcher/n8n_workflow_watcher.py tools/n8n-workflow-watcher/test_n8n_workflow_watcher.py
git commit -m "feat(n8n-recovery): detector creates diagnosed Paperclip issues (idempotent, meta-fallback)"
```

---

## Task 4: Diagnose-Agent (claude_local, read-only) anlegen

**Files:**
- Create: `tools/n8n-workflow-watcher/agent/AGENTS.md`
- Modify: `~/.paperclip/scripts/agents-instructions/build_manifest.py`

Kein Unit-Test (API-/Konfigschritt). Verifikation per Live-Call.

- [ ] **Step 1: Instructions des Agenten schreiben** → `tools/n8n-workflow-watcher/agent/AGENTS.md`

```markdown
# n8n-Betriebsingenieur (Diagnose, read-only)

Du bist der n8n-Betriebsingenieur der Firma WHITESTAG und berichtest an den CTO.
Deine Aufgabe: zugewiesene **n8n-Fehler-Issues** diagnostizieren, die Ursache
klassifizieren, das Ergebnis dokumentieren und Unklares an den CTO eskalieren.

## STRIKT READ-ONLY (Phase A)
Du darfst **NICHTS** verändern. Verboten sind insbesondere:
`n8n execute`, `n8n update:workflow`, `n8n publish/unpublish`, jeglicher n8n-Neustart,
Credential-Änderungen, Edits an Workflow-JSON, Schreibzugriffe auf `~/.n8n/`.
Reparatur passiert erst in einer späteren Ausbaustufe (Plan B) über einen Approval-Pfad.

## Erlaubte Werkzeuge
- Lesen der n8n-DB **nur read-only**:
  `sqlite3 'file:'"$HOME"'/.n8n/database.sqlite?mode=ro' '<SELECT ...>'`
- Read-only-Healthcheck: `curl -s http://127.0.0.1:5678/healthz`
- Paperclip: Kommentar an das Issue schreiben, Subtask zur Eskalation an den CTO anlegen,
  das Nacht-Rollup-Issue pflegen (über die Paperclip-Tools/Skill).

## Ablauf je zugewiesenem Issue
1. Lies Titel/Beschreibung (enthält Workflow-Name, `exec_id`, Fehlermeldung, Node).
2. Bei Bedarf Detail aus `execution_data` nachladen (read-only-SQL, siehe oben).
3. Klassifiziere die Ursache in genau **eine** Kategorie:
   - `env/restart` — z.B. `access to env vars denied`, `Module '...' is disallowed`,
     Orphan-n8n ohne korrekte Env (→ Plan B: Neustart, ROT).
   - `credential` — 401/403, abgelaufener/rotierter Token (→ Plan B: Credential-Sync, ROT).
   - `workflow-deaktiviert` — Trigger inaktiv / Workflow auf inactive (→ Plan B: Reaktivieren, GRÜN).
   - `transient` — Timeout, kurzzeitiger Netzfehler, LLM-Timeout (→ Plan B: Retry, GRÜN).
   - `code/config-bug` — Node-Fehlkonfiguration, ungültiger Modellname, fehlender Key
     (NICHT automatisch behebbar → immer Eskalation an Mensch/CTO).
   - `unklar` — Diagnose nicht eindeutig.
4. Schreibe einen Kommentar ans Issue mit: **Kategorie**, **Kurzdiagnose** (1–3 Sätze),
   **empfohlene Maßnahme** (was Plan-B-Recovery tun würde, GRÜN/ROT), **Confidence** (hoch/mittel/niedrig).
5. Bei Kategorie `code/config-bug` oder `unklar` **und** Confidence ≠ hoch:
   lege einen Subtask „Eskalation: <Workflow>" an, der an den CTO berichtet, mit deiner Diagnose.
6. Trage das Issue in das heutige Rollup-Issue „n8n Ops `<YYYY-MM-DD>`" ein
   (lege es an, falls noch nicht vorhanden): Zeile pro Issue mit Workflow, Kategorie, Maßnahme.

## Anti-Halluzination
Erfinde keine Fehlermeldungen, Node-Namen oder Ursachen. Wenn `execution_data` nichts
hergibt, schreibe das explizit und stufe als `unklar` ein. Keine Spekulation als Fakt.
```

- [ ] **Step 2: Agent per API anlegen (Hire) + Instructions-Bundle übergeben**

Run (Token wie unten; `entryFile` = AGENTS.md, Inhalt aus Step 1):

```bash
cd tools/n8n-workflow-watcher
TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.paperclip/auth.json')))['credentials']['http://localhost:3100']['token'])")
python3 - "$TOKEN" <<'PY'
import json, sys, urllib.request
token = sys.argv[1]
agents_md = open("agent/AGENTS.md", encoding="utf-8").read()
payload = {
    "name": "n8n-Betriebsingenieur",
    "role": "engineer",
    "title": "n8n Reliability Engineer (Diagnose)",
    "reportsTo": "5b7cb8a7-945f-4861-b3a7-4ae84d242d1e",  # CTO
    "adapterType": "claude_local",
    "capabilities": ("Diagnostiziert zugewiesene n8n-Fehler-Issues read-only, "
                     "klassifiziert die Ursache, eskaliert Unklares an den CTO."),
    "budgetMonthlyCents": 20000,
    "adapterConfig": {"model": "claude-opus-4-8"},
    "instructionsBundle": {"entryFile": "AGENTS.md", "files": {"AGENTS.md": agents_md}},
}
req = urllib.request.Request(
    "http://localhost:3100/api/companies/9cebf3cf-efe8-4597-a400-f06488900a87/agent-hires",
    data=json.dumps(payload).encode(), method="POST",
    headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
print(urllib.request.urlopen(req).read().decode())
PY
```

Expected: JSON mit der neuen Agent-`id` und (wegen Approval-Gate) einer Approval/`hire`-Referenz.
Notiere die Agent-`id` und die Approval-`id`.

- [ ] **Step 3: Hire genehmigen**

```bash
TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.paperclip/auth.json')))['credentials']['http://localhost:3100']['token'])")
curl -s -X POST "http://localhost:3100/api/approvals/<APPROVAL_ID>/approve" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"decisionNote":"n8n-Diagnose-Agent, read-only, genehmigt"}'
```

Expected: `{"...","status":"approved",...}`; Agent-Status wechselt `pending_approval → idle`.

- [ ] **Step 4: Agent vom nächtlichen Generator ausnehmen**

In `~/.paperclip/scripts/agents-instructions/build_manifest.py` die Zeile

```python
EXCLUDE_NAMES = {"HomePod-Test-Agent"}
```

ändern zu

```python
EXCLUDE_NAMES = {"HomePod-Test-Agent", "n8n-Betriebsingenieur"}
```

(Damit der Generator die read-only-Playbook-AGENTS.md nicht nachts mit einer Rollen-Vorlage
überschreibt.)

- [ ] **Step 5: Verifizieren, dass der Agent existiert und ausgenommen ist**

```bash
TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.paperclip/auth.json')))['credentials']['http://localhost:3100']['token'])")
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3100/api/companies/9cebf3cf-efe8-4597-a400-f06488900a87/agents" \
  | python3 -c "import sys,json;[print(a['id'],a['name'],a.get('status'),a.get('reportsTo')) for a in json.load(sys.stdin) if a['name']=='n8n-Betriebsingenieur']"
cd ~/.paperclip/scripts/agents-instructions && python3 build_manifest.py | tail -1
python3 -c "import json;print('n8n-Betriebsingenieur' not in [a['name'] for a in json.load(open('agents-manifest.json'))])"
```

Expected: Agent-Zeile mit `status=idle`, korrektem `reportsTo` (CTO); Manifest-Check druckt `True`.

- [ ] **Step 6: Commit (Repo-Teile) + Memory**

```bash
git add tools/n8n-workflow-watcher/agent/AGENTS.md
git commit -m "feat(n8n-recovery): read-only diagnostic agent instructions + manifest exclusion note"
```

(`build_manifest.py` liegt in `~/.paperclip/scripts/` außerhalb des Repos — die Änderung dort
ist Laufzeit-Deploy; im Repo wird die Quelle, falls vorhanden, separat gepflegt. In der
Commit-Message vermerken, dass `EXCLUDE_NAMES` live ergänzt wurde.)

---

## Task 5: Detektor-Agent-ID verdrahten, deployen, end-to-end verifizieren

**Files:**
- Modify: `tools/n8n-workflow-watcher/ing.paperclip.n8n-workflow-watcher.plist`
- Modify: `tools/n8n-workflow-watcher/DEPLOY.md`

- [ ] **Step 1: plist um Env-Vars erweitern**

In `ing.paperclip.n8n-workflow-watcher.plist` einen `EnvironmentVariables`-Block ergänzen
(Agent-ID aus Task 4 Step 2 einsetzen; Token wird vom Skript aus `auth.json` geladen, daher
genügt die Agent-ID):

```xml
    <key>EnvironmentVariables</key>
    <dict>
        <key>N8N_RECOVERY_AGENT_ID</key>
        <string><NEUE_AGENT_ID></string>
    </dict>
```

- [ ] **Step 2: Drei Skript-Dateien + plist deployen**

```bash
cd tools/n8n-workflow-watcher
cp n8n_workflow_watcher.py n8n_execution_error.py paperclip_client.py ~/.paperclip/scripts/
cp ing.paperclip.n8n-workflow-watcher.plist ~/Library/LaunchAgents/
launchctl unload ~/Library/LaunchAgents/ing.paperclip.n8n-workflow-watcher.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/ing.paperclip.n8n-workflow-watcher.plist
```

- [ ] **Step 3: DEPLOY.md aktualisieren**

`DEPLOY.md` ergänzen: Es werden jetzt **drei** Python-Dateien nach `~/.paperclip/scripts/`
kopiert (`n8n_workflow_watcher.py`, `n8n_execution_error.py`, `paperclip_client.py`);
neue Env-Var `N8N_RECOVERY_AGENT_ID` in der plist; Token wird aus `~/.paperclip/auth.json`
geladen. Hinweis: System-`/usr/bin/python3`, nur stdlib.

- [ ] **Step 4: Dry-run gegen Live-DB**

```bash
cd ~/.paperclip/scripts && N8N_RECOVERY_AGENT_ID=<NEUE_AGENT_ID> /usr/bin/python3 n8n_workflow_watcher.py --dry-run
```

Expected: Liste der Issue-Titel, die angelegt würden (oder „keine neuen Fehler-Executions").
**Es wird nichts angelegt und nicht gemailt.**

- [ ] **Step 5: Ein echter Lauf + Verifikation** (nur wenn echte Findings existieren)

```bash
cd ~/.paperclip/scripts && N8N_RECOVERY_AGENT_ID=<NEUE_AGENT_ID> /usr/bin/python3 n8n_workflow_watcher.py --once
TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.paperclip/auth.json')))['credentials']['http://localhost:3100']['token'])")
# Issue(s) zugewiesen an den Agenten prüfen:
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3100/api/companies/9cebf3cf-efe8-4597-a400-f06488900a87/issues?assigneeAgentId=<NEUE_AGENT_ID>" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(len(d if isinstance(d,list) else d.get('issues',[])),'issue(s)')"
```

Expected: ≥1 Issue; State-Datei enthält die `exec_id`(s) unter `reported_exec_ids`; ein
zweiter Lauf legt **keine** Duplikate an (Idempotenz). Innerhalb weniger Minuten sollte der
Agent (Task-Wake) einen Diagnose-Kommentar gepostet haben — im Issue prüfen.

- [ ] **Step 6: Commit**

```bash
git add tools/n8n-workflow-watcher/ing.paperclip.n8n-workflow-watcher.plist tools/n8n-workflow-watcher/DEPLOY.md
git commit -m "chore(n8n-recovery): wire recovery agent id, deploy three-file detector, docs"
```

---

## Plan B (Ausblick, separater Plan)

Nicht Teil dieses Plans — wird nach Bewährung des Diagnose-Loops als eigener Plan geschrieben:

1. **Recovery-Toolkit (CLI):** `n8n_health.py` (read-only Diagnose: Prozess/Env/`healthz`),
   `n8n_reactivate_workflow.py` (🟢 `n8n update:workflow --active=true`, mit korrektem Env-Wrapper,
   inkl. Klärung der „aktiv erst nach Restart"-Frage), `n8n_reexecute_workflow.py`
   (🟢 `n8n execute --id=<wf>`, nur Nicht-Trigger-Workflows, Env aus `~/.whitestag.env`, max 1×).
2. **Autonomie-Stufen scharf schalten:** GRÜN-Aktionen automatisch, ROT (n8n-Neustart,
   Credential-Sync, Workflow-JSON-Edit) über `POST /api/companies/{cid}/approvals`
   (`type: request_board_approval`) an den CTO, Ausführung erst nach `approve`.
3. **Instructions Phase B:** read-only-Verbot lockern auf das gestufte Modell; GRÜN/ROT-Mapping
   der Kategorien aus Plan A produktiv schalten.
4. **Optionaler Ausbau:** n8n Public REST-API-Key setzen (sauberer Retry/Activate ohne CLI-Env-Fragilität).

---

## Self-Review

**Spec-Abdeckung (gegen die Design-Spec):**
- Detektor erstellt Tasks statt Mail → Task 3. ✓
- Idempotenz über `exec_id` → Task 3 (`new_findings`, `reported_exec_ids`). ✓
- Diagnose aus `execution_data` → Task 1 + Task-3-Anreicherung. ✓
- claude_local-Agent unter CTO, Task-Wake → Task 4. ✓
- Reporting als Rollup-Task, keine Morgen-Mail → Agent-Instructions (Task 4) + Heartbeat-Mail entfernt (Task 3). ✓
- Meta-Monitoring-Fallback-Mail → Task 3. ✓
- Nächtliche Kadenz / launchd unverändert → Task 5 (plist-Env ergänzt, Zeitplan bleibt). ✓
- Generator-Überschreibschutz → Task 4 Step 4 (`EXCLUDE_NAMES`). ✓
- **Bewusst auf Plan B verschoben** (in dieser Spec als „Auto-Recovery" angelegt): mutierende
  Fixes (Retry/Reaktivieren), GRÜN/ROT-Autonomie, Approval-Pfad. In Plan A ist der Agent
  read-only. Dies ist die in der Brainstorming-Entscheidung „Zwei Pläne" gewählte Aufteilung.

**Platzhalter-Scan:** `<APPROVAL_ID>`, `<NEUE_AGENT_ID>` sind Laufzeit-Werte, die in Task 4/5
erzeugt und eingesetzt werden — bewusst, keine offenen TODOs im Code.

**Typ-/Namens-Konsistenz:** `read_execution_error`, `extract_error`, `create_issue`,
`add_comment`, `new_findings`, `build_issue`, `RECOVERY_AGENT_ID`, `reported_exec_ids`,
`COMPANY_ID` durchgängig identisch in Tasks 1–3 und Tests verwendet. ✓
