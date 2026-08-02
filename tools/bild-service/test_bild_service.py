import pytest

import bild_service
import comfy_client
import config
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


def _stub_list_issues(monkeypatch, backlog):
    """backlog: {(company_id, status): [issue, ...]} — alles andere liefert []."""
    def fn(company_id, status, label_id, limit=100):
        return backlog.get((company_id, status), [])
    monkeypatch.setattr(bild_service.api, "list_issues", fn)


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


# --- Fix round 1: Finding 1 — Retry muss den tatsaechlich benutzten Seed speichern ------

def test_timeout_retry_stores_the_newly_submitted_seed(monkeypatch, tmp_path):
    setup(monkeypatch, tmp_path)
    job_state.add("issue-1", "prompt-1", "company-a", now=0.0, seed=111)
    monkeypatch.setattr(comfy_client, "poll", lambda pid: ("running", None))
    monkeypatch.setattr(comfy_client, "submit", lambda wf: "prompt-2")
    monkeypatch.setattr(bild_service, "_brief_for_issue", lambda job: {
        "error": None, "prompt": "Hirsch", "modell": "qwen", "size": "1024x1024",
        "width": 1024, "height": 1024, "openai_size": "1024x1024",
        "quality": "medium", "background": "opaque", "seed": 268313160})
    result = bild_service.collect_one("issue-1", job_state.get("issue-1"), now=999999.0)
    assert result == "timeout"
    job = job_state.get("issue-1")
    assert job["prompt_id"] == "prompt-2"
    assert job["seed"] == 268313160          # nicht mehr der alte Seed (111) des ersten Versuchs


# --- Fix round 1: Finding 2 — ein gescheiterter Alarm darf die Sperre nicht dauerhaft setzen --

def test_unreachable_alert_retries_after_transient_failure(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    monkeypatch.setattr(comfy_client, "health", lambda: False)
    calls = {"n": 0}

    def flaky_waiting_issues():
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("Paperclip kurz nicht erreichbar")
        return [("company-a", "issue-1")]

    monkeypatch.setattr(bild_service, "_waiting_issues", flaky_waiting_issues)
    from config import UNREACHABLE_ALERT_CYCLES
    for _ in range(UNREACHABLE_ALERT_CYCLES):
        bild_service.note_unreachable()
    assert api.mails == []           # erster Versuch bei Erreichen der Schwelle ist gescheitert
    bild_service.note_unreachable()  # naechster Zyklus versucht es erneut und hat Erfolg
    assert len(api.mails) == 1
    bild_service.note_unreachable()  # danach nicht nochmal
    assert len(api.mails) == 1


def test_unreachable_alert_reraises_auth_error(monkeypatch, tmp_path):
    setup(monkeypatch, tmp_path)
    monkeypatch.setattr(comfy_client, "health", lambda: False)

    def boom():
        raise bild_service.api.AuthError("Token abgelaufen")

    monkeypatch.setattr(bild_service, "_waiting_issues", boom)
    from config import UNREACHABLE_ALERT_CYCLES
    for _ in range(UNREACHABLE_ALERT_CYCLES - 1):
        bild_service.note_unreachable()
    with pytest.raises(bild_service.api.AuthError):
        bild_service.note_unreachable()


# --- Fix round 1: Finding 3 — der Inflight-Deckel darf den OpenAI-Pfad nicht aushungern --

def test_submit_phase_still_processes_openai_when_local_queue_full(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    for i in range(config.MAX_INFLIGHT_JOBS):
        job_state.add("local-%d" % i, "prompt-%d" % i, "company-a", now=1000.0)
    company_id = config.COMPANIES[0]["id"]
    status = config.POLL_STATUSES[0]
    openai_issue = {"id": "issue-openai",
                    "description": "prompt: Hirsch\nmodell: openai\nformat: 1024x1024\nquality: medium"}
    _stub_list_issues(monkeypatch, {(company_id, status): [openai_issue]})
    monkeypatch.setattr(bild_service, "generate_png", lambda brief: b"PNGDATA")
    bild_service.submit_phase(now=2000.0)
    assert api.status.get("issue-openai") == "done"


# --- Fix round 1: Finding 4 — die Phasenfunktionen brauchen eigene Tests ------------------

def test_collect_phase_isolates_failure_and_collects_others(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    job_state.add("issue-bad", "prompt-bad", "company-a", now=1000.0)
    job_state.add("issue-good", "prompt-good", "company-a", now=1000.0)

    def fake_poll(pid):
        if pid == "prompt-bad":
            raise RuntimeError("boom")
        return ("done", [{"filename": "a.png", "subfolder": "", "type": "output"}])

    monkeypatch.setattr(comfy_client, "poll", fake_poll)
    monkeypatch.setattr(comfy_client, "fetch_image", lambda img: b"PNGDATA")
    bild_service.collect_phase(now=1010.0)
    assert api.status.get("issue-good") == "done"
    assert job_state.get("issue-good") is None
    assert job_state.get("issue-bad") is not None   # blieb liegen, naechster Zyklus versucht erneut
    assert api.mails                                # Fehler wurde gemeldet, nicht verschluckt


def test_submit_phase_skips_issue_with_existing_job(monkeypatch, tmp_path):
    setup(monkeypatch, tmp_path)
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0)
    company_id = config.COMPANIES[0]["id"]
    status = config.POLL_STATUSES[0]
    already_queued = {"id": "issue-1", "description": "prompt: Hirsch\nmodell: qwen"}
    _stub_list_issues(monkeypatch, {(company_id, status): [already_queued]})
    submitted = []
    monkeypatch.setattr(comfy_client, "submit", lambda wf: submitted.append(1) or "prompt-x")
    bild_service.submit_phase(now=2000.0)
    assert submitted == []
    assert job_state.get("issue-1")["prompt_id"] == "prompt-1"


def test_run_once_alerts_then_resets_after_recovery(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    _stub_list_issues(monkeypatch, {})
    monkeypatch.setattr(comfy_client, "health", lambda: False)
    from config import UNREACHABLE_ALERT_CYCLES
    for _ in range(UNREACHABLE_ALERT_CYCLES):
        bild_service.run_once(now=1000.0)
    assert len(api.mails) == 1

    monkeypatch.setattr(comfy_client, "health", lambda: True)
    bild_service.run_once(now=1000.0)
    assert bild_service._unreachable_cycles == 0
    assert bild_service._unreachable_alerted is False

    monkeypatch.setattr(comfy_client, "health", lambda: False)
    for _ in range(UNREACHABLE_ALERT_CYCLES):
        bild_service.run_once(now=1000.0)
    assert len(api.mails) == 2   # neuer Ausfall wird erneut gemeldet, weil der Zaehler zurueckgesetzt wurde


# --- Fix round 1: Finding 5 — nicht-auth Paperclip-Fehler duerfen run_once nicht sprengen --

def test_run_once_survives_broad_paperclip_failure(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    monkeypatch.setattr(comfy_client, "health", lambda: True)

    def raising_list_issues(*a, **k):
        raise OSError("Verbindung abgelehnt")

    monkeypatch.setattr(bild_service.api, "list_issues", raising_list_issues)
    bild_service.run_once(now=1000.0)     # darf nicht crashen
    assert api.mails == ["[Bilddienst] Zyklus abgebrochen"]
