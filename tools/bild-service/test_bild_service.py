import os
import tempfile

import bild_service
import comfy_client
import cost_state
import job_state


class FakeApi(object):
    def __init__(self):
        self.comments = []
        self.status = {}
        self.attachments = []
        self.mails = []

    def add_comment(self, issue_id, body):
        self.comments.append((issue_id, body))

    def patch_status(self, issue_id, status):
        self.status[issue_id] = status

    def upload_attachment(self, company_id, issue_id, filename, data):
        self.attachments.append((issue_id, filename, len(data)))

    def mail_alarm(self, subject, text):
        self.mails.append(subject)


def setup(monkeypatch, tmp_path):
    state = str(tmp_path / "state.json")
    cost_state.STATE_FILE = state
    job_state.STATE_FILE = state
    api = FakeApi()
    for name in ("add_comment", "patch_status", "upload_attachment", "mail_alarm"):
        monkeypatch.setattr(bild_service.api, name, getattr(api, name))
    bild_service.reset_unreachable_counter()
    return api


COMPANY = {"name": "Test", "id": "company-a", "label": "label-a"}


def test_submit_registers_job(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    monkeypatch.setattr(comfy_client, "submit", lambda wf: "prompt-1")
    brief = {"error": None, "prompt": "Hirsch", "modell": "qwen", "size": "1024x1024",
             "width": 1024, "height": 1024, "openai_size": "1024x1024",
             "quality": "medium", "background": "opaque", "seed": 42}
    bild_service.render_local(COMPANY, {"id": "issue-1"}, brief, now=1000.0)
    assert job_state.get("issue-1")["prompt_id"] == "prompt-1"
    assert api.status == {}          # bleibt offen, bis das Bild da ist


def test_collect_done_uploads_and_closes(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0)
    monkeypatch.setattr(comfy_client, "poll",
                        lambda pid: ("done", [{"filename": "a.png", "subfolder": "", "type": "output"}]))
    monkeypatch.setattr(comfy_client, "fetch_image", lambda img: b"PNGDATA")
    result = bild_service.collect_one("issue-1", job_state.get("issue-1"), now=1010.0)
    assert result == "done"
    assert api.attachments == [("issue-1", "bild-issue-1.png", 7)]
    assert api.status["issue-1"] == "done"
    assert job_state.get("issue-1") is None


def test_collect_error_cancels_without_retry(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0)
    monkeypatch.setattr(comfy_client, "poll", lambda pid: ("error", "UNETLoader: Modell fehlt"))
    result = bild_service.collect_one("issue-1", job_state.get("issue-1"), now=1010.0)
    assert result == "error"
    assert api.status["issue-1"] == "cancelled"
    assert "Modell fehlt" in api.comments[0][1]
    assert job_state.get("issue-1") is None


def test_timeout_retries_once(monkeypatch, tmp_path):
    setup(monkeypatch, tmp_path)
    job_state.add("issue-1", "prompt-1", "company-a", now=0.0)
    monkeypatch.setattr(comfy_client, "poll", lambda pid: ("running", None))
    monkeypatch.setattr(comfy_client, "submit", lambda wf: "prompt-2")
    monkeypatch.setattr(bild_service, "_brief_for_issue", lambda job: {
        "error": None, "prompt": "Hirsch", "modell": "qwen", "size": "1024x1024",
        "width": 1024, "height": 1024, "openai_size": "1024x1024",
        "quality": "medium", "background": "opaque", "seed": 42})
    result = bild_service.collect_one("issue-1", job_state.get("issue-1"), now=999999.0)
    assert result == "timeout"
    job = job_state.get("issue-1")
    assert job["attempts"] == 2
    assert job["prompt_id"] == "prompt-2"


def test_second_timeout_cancels(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    job_state.add("issue-1", "prompt-1", "company-a", now=0.0)
    job_state.bump_attempt("issue-1", "prompt-2", now=0.0)
    monkeypatch.setattr(comfy_client, "poll", lambda pid: ("running", None))
    result = bild_service.collect_one("issue-1", job_state.get("issue-1"), now=999999.0)
    assert result == "error"
    assert api.status["issue-1"] == "cancelled"
    assert job_state.get("issue-1") is None
    assert api.mails


def test_local_daily_limit_blocks_and_comments(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    for _ in range(cost_state.DAILY_LOCAL_LIMIT):
        cost_state.record_local("2026-08-02")
    monkeypatch.setattr(bild_service, "_today", lambda: "2026-08-02")
    brief = {"error": None, "prompt": "Hirsch", "modell": "qwen", "size": "1024x1024",
             "width": 1024, "height": 1024, "openai_size": "1024x1024",
             "quality": "medium", "background": "opaque", "seed": None}
    bild_service.render_local(COMPANY, {"id": "issue-1"}, brief, now=1000.0)
    assert job_state.get("issue-1") is None
    assert api.status["issue-1"] == "cancelled"
    assert "Tageslimit" in api.comments[0][1]


def test_unreachable_alerts_once_after_threshold(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    monkeypatch.setattr(comfy_client, "health", lambda: False)
    monkeypatch.setattr(bild_service, "_waiting_issues", lambda: [("company-a", "issue-1")])
    from config import UNREACHABLE_ALERT_CYCLES
    for _ in range(UNREACHABLE_ALERT_CYCLES):
        bild_service.note_unreachable()
    assert len(api.mails) == 1
    assert len(api.comments) == 1
    bild_service.note_unreachable()          # weitere Zyklen alarmieren nicht erneut
    assert len(api.mails) == 1
