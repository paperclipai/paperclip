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
    # now knapp ueber JOB_TIMEOUT_SEC (300), aber deutlich unter der Finding-2-
    # Notausstiegsschwelle (10x = 3000) -- die soll hier nicht mitgreifen.
    result = bild_service.collect_one("issue-1", job_state.get("issue-1"), now=400.0)
    assert result == "timeout"
    job = job_state.get("issue-1")
    assert job["attempts"] == 2
    assert job["prompt_id"] == "prompt-2"


def test_second_timeout_cancels(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    job_state.add("issue-1", "prompt-1", "company-a", now=0.0)
    job_state.bump_attempt("issue-1", "prompt-2", now=0.0)
    monkeypatch.setattr(comfy_client, "poll", lambda pid: ("running", None))
    result = bild_service.collect_one("issue-1", job_state.get("issue-1"), now=400.0)
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
    result = bild_service.collect_one("issue-1", job_state.get("issue-1"), now=400.0)
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
    # Zaehler leben in job_state (Datei), nicht mehr als bild_service-Modul-Globals
    assert job_state.unreachable_cycles() == 0
    assert job_state.is_unreachable_alerted() is False

    monkeypatch.setattr(comfy_client, "health", lambda: False)
    for _ in range(UNREACHABLE_ALERT_CYCLES):
        bild_service.run_once(now=1000.0)
    assert len(api.mails) == 2   # neuer Ausfall wird erneut gemeldet, weil der Zaehler zurueckgesetzt wurde


# --- Fix round 1: Finding 5 — nicht-auth Paperclip-Fehler duerfen run_once nicht sprengen --

# --- Fix round: Finding 1 (KRITISCH) — der Zaehler muss einen echten Prozess- ---
# --- neustart ueberleben, nicht nur einen simulierten "in-memory reset".      ---
# --- launchd startet fuer JEDEN Zyklus (StartInterval, kein KeepAlive) einen  ---
# --- frischen Python-Prozess -- Modul-Globals in bild_service.py wuerden      ---
# --- dabei jedes Mal auf 0 zurueckfallen und die Schwelle nie erreichen.      ---

def test_unreachable_alert_survives_process_restart_between_cycles(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    monkeypatch.setattr(comfy_client, "health", lambda: False)
    monkeypatch.setattr(bild_service, "_waiting_issues",
                        lambda: [("company-a", "issue-1")])

    from config import UNREACHABLE_ALERT_CYCLES
    half = UNREACHABLE_ALERT_CYCLES // 2
    for _ in range(half):
        bild_service.note_unreachable()
    assert api.mails == []          # noch nicht an der Schwelle

    # Echter Prozessneustart, wie launchd ihn zwischen zwei Zyklen erzeugt:
    # bild_service komplett neu importieren. Ein Modul-Global-Zaehler wuerde
    # hier auf 0 zurueckfallen (die alte, kaputte Implementierung); der
    # persistente Zaehler in job_state (eigene Datei, ueberlebt den Reimport
    # unveraendert) muss den Fortschritt behalten.
    import importlib
    restarted = importlib.reload(bild_service)
    for name in ("add_comment", "patch_status", "upload_attachment", "mail_alarm"):
        monkeypatch.setattr(restarted.api, name, getattr(api, name))
    monkeypatch.setattr(restarted, "_waiting_issues",
                        lambda: [("company-a", "issue-1")])
    monkeypatch.setattr(comfy_client, "health", lambda: False)

    for _ in range(UNREACHABLE_ALERT_CYCLES - half):
        restarted.note_unreachable()
    assert len(api.mails) == 1       # Schwelle wurde ueber den Neustart hinweg erreicht


# --- Fix round 2: Finding 2 — absoluter Notausstieg fuer haengengebliebene Jobs ---

def test_collect_one_reaps_job_stuck_past_absolute_age_ceiling(monkeypatch, tmp_path):
    """Wenn die 'done'-Verarbeitung wiederholt scheitert (Issue geloescht,
    Ausgabedatei weg, ...), bleibt der Job nie in job_state.drop() angekommen
    und der Knoten meldet bei jedem Zyklus wieder 'done'. Ohne Backstop wuerde
    das fuer immer einen der drei Inflight-Plaetze blockieren."""
    api = setup(monkeypatch, tmp_path)
    job_state.add("issue-1", "prompt-1", "company-a", now=0.0)
    monkeypatch.setattr(comfy_client, "poll",
                        lambda pid: ("done", [{"filename": "a.png", "subfolder": "", "type": "output"}]))
    ceiling = config.JOB_TIMEOUT_SEC * config.STUCK_JOB_AGE_MULTIPLIER
    result = bild_service.collect_one("issue-1", job_state.get("issue-1"), now=ceiling + 1)
    assert result == "error"
    assert api.status["issue-1"] == "cancelled"
    assert job_state.get("issue-1") is None
    assert api.mails


def test_collect_one_does_not_reap_job_just_under_the_ceiling(monkeypatch, tmp_path):
    """Gegenprobe: kurz VOR der Schwelle darf der Backstop nicht greifen,
    sonst wuerde er den normalen Erfolgsfall kaputt machen."""
    api = setup(monkeypatch, tmp_path)
    job_state.add("issue-1", "prompt-1", "company-a", now=0.0)
    monkeypatch.setattr(comfy_client, "poll",
                        lambda pid: ("done", [{"filename": "a.png", "subfolder": "", "type": "output"}]))
    monkeypatch.setattr(comfy_client, "fetch_image", lambda img: b"PNGDATA")
    ceiling = config.JOB_TIMEOUT_SEC * config.STUCK_JOB_AGE_MULTIPLIER
    result = bild_service.collect_one("issue-1", job_state.get("issue-1"), now=ceiling - 1)
    assert result == "done"
    assert api.status["issue-1"] == "done"


# --- Fix round 2: Finding 3 — der 'done'-Pfad muss idempotent sein --------------

def test_collect_done_does_not_reupload_after_comment_fails_on_first_try(monkeypatch, tmp_path):
    """upload_attachment() klappt, add_comment() scheitert danach (z.B. weil
    Paperclip gerade per kickstart neu gestartet wird). Der naechste Zyklus
    pollt erneut 'done' -- er darf das PNG nicht ein zweites Mal hochladen,
    muss den Auftrag aber trotzdem sauber abschliessen."""
    api = setup(monkeypatch, tmp_path)
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0)
    monkeypatch.setattr(comfy_client, "poll",
                        lambda pid: ("done", [{"filename": "a.png", "subfolder": "", "type": "output"}]))
    monkeypatch.setattr(comfy_client, "fetch_image", lambda img: b"PNGDATA")

    calls = {"n": 0}

    def flaky_comment(issue_id, body):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("Paperclip kickstart mittendrin")
        api.comments.append((issue_id, body))

    monkeypatch.setattr(bild_service.api, "add_comment", flaky_comment)

    with pytest.raises(RuntimeError):
        bild_service.collect_one("issue-1", job_state.get("issue-1"), now=1010.0)
    assert api.attachments == [("issue-1", "bild-issue-1.png", 7)]
    assert job_state.get("issue-1")["uploaded"] is True

    # Naechster Zyklus: Kommentar klappt jetzt -- aber kein zweiter Upload
    result = bild_service.collect_one("issue-1", job_state.get("issue-1"), now=1020.0)
    assert result == "done"
    assert api.attachments == [("issue-1", "bild-issue-1.png", 7)]   # unveraendert, kein zweiter Upload
    assert api.status["issue-1"] == "done"
    assert job_state.get("issue-1") is None


# --- Fix round 2: Finding 4 — Retry-Zweig muss brief['error'] pruefen -----------

def test_timeout_retry_cancels_when_brief_became_invalid(monkeypatch, tmp_path):
    """Wenn die Beschreibung waehrend des Renderns geleert wurde, liefert
    parse_brief() beim Wiederholversuch einen Fehler (prompt: None). Ohne
    diese Pruefung wuerde workflow_template.fill() ein Bild des Worts 'ul'
    rendern und den Auftrag trotzdem als 'done' schliessen."""
    api = setup(monkeypatch, tmp_path)
    job_state.add("issue-1", "prompt-1", "company-a", now=0.0)
    monkeypatch.setattr(comfy_client, "poll", lambda pid: ("running", None))
    submitted = []
    monkeypatch.setattr(comfy_client, "submit", lambda wf: submitted.append(1) or "prompt-2")
    monkeypatch.setattr(bild_service, "_brief_for_issue", lambda job: {
        "error": "Pflichtfeld 'prompt' fehlt oder ist leer.", "prompt": None, "modell": "qwen",
        "size": "1024x1024", "width": 1024, "height": 1024, "openai_size": "1024x1024",
        "quality": "medium", "background": "opaque", "seed": None})
    result = bild_service.collect_one("issue-1", job_state.get("issue-1"), now=400.0)
    assert result == "error"
    assert api.status["issue-1"] == "cancelled"
    assert "Pflichtfeld" in api.comments[0][1]
    assert job_state.get("issue-1") is None
    assert submitted == []       # kein neuer Render-Versuch mit kaputtem Brief


# --- Fix round 2: Finding 5 — voller Knoten muss der Agentin ein Signal geben ---

def test_full_queue_comments_once_and_clears_notice_once_submitted(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    for i in range(config.MAX_INFLIGHT_JOBS):
        job_state.add("other-%d" % i, "prompt-%d" % i, "company-a", now=1000.0)
    brief = {"error": None, "prompt": "Hirsch", "modell": "qwen", "size": "1024x1024",
             "width": 1024, "height": 1024, "openai_size": "1024x1024",
             "quality": "medium", "background": "opaque", "seed": 42}

    bild_service.render_local(COMPANY, {"id": "issue-1"}, brief, now=1000.0)
    bild_service.render_local(COMPANY, {"id": "issue-1"}, brief, now=1060.0)
    bild_service.render_local(COMPANY, {"id": "issue-1"}, brief, now=1120.0)
    assert len(api.comments) == 1        # nur einmal, nicht bei jedem Zyklus
    assert "Warteschlange" in api.comments[0][1]
    assert job_state.get("issue-1") is None

    # Ein Slot wird frei -> naechster Zyklus rendert und der Marker wird geloescht
    job_state.drop("other-0")
    monkeypatch.setattr(comfy_client, "submit", lambda wf: "prompt-issue-1")
    bild_service.render_local(COMPANY, {"id": "issue-1"}, brief, now=1180.0)
    assert job_state.get("issue-1")["prompt_id"] == "prompt-issue-1"
    assert job_state.has_queue_notice("issue-1") is False
    assert len(api.comments) == 1        # weiterhin nur der eine Warteschlange-Kommentar


def test_run_once_survives_broad_paperclip_failure(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    monkeypatch.setattr(comfy_client, "health", lambda: True)

    def raising_list_issues(*a, **k):
        raise OSError("Verbindung abgelehnt")

    monkeypatch.setattr(bild_service.api, "list_issues", raising_list_issues)
    bild_service.run_once(now=1000.0)     # darf nicht crashen
    assert api.mails == ["[Bilddienst] Zyklus abgebrochen"]


# --- Modellabhaengige Vorlage und Zeitgrenze ------------------------------

def test_workflow_name_per_model():
    assert bild_service._workflow_name("qwen") == "qwen-image"
    assert bild_service._workflow_name("qwen360") == "qwen-360"


def test_workflow_name_unknown_falls_back_to_default():
    assert bild_service._workflow_name("gibtsnicht") == "qwen-image"
    assert bild_service._workflow_name(None) == "qwen-image"


def test_job_timeout_is_longer_for_360():
    """360 laeuft gemessen ~330 s; mit dem 300-s-Standarddeckel wuerde jeder
    Lauf kurz vor dem Ziel abgeraeumt und sinnlos neu eingereiht."""
    assert bild_service._job_timeout("qwen360") == 900
    assert bild_service._job_timeout("qwen") == 300
    assert bild_service._job_timeout(None) == 300


# --- render_edit: Bild-zu-Bild ueber qwenedit ------------------------------

EDIT_BRIEF = {"error": None, "prompt": "entferne die Person", "modell": "qwenedit",
              "size": "1024x1024", "width": 1024, "height": 1024,
              "openai_size": "1024x1024", "quality": "medium",
              "background": "opaque", "seed": 42, "format_ignored": False}


def _att(id_, created, ctype="image/png", size=1000):
    return {"id": id_, "createdAt": created, "contentType": ctype,
            "byteSize": size, "originalFilename": id_ + ".png"}


def test_edit_laedt_bilder_hoch_und_merkt_sie_sich(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    monkeypatch.setattr(bild_service.api, "list_attachments",
                        lambda iid: [_att("zwei", "2026-08-04T11:00:00.000Z"),
                                     _att("eins", "2026-08-04T10:00:00.000Z")])
    monkeypatch.setattr(bild_service.api, "fetch_attachment", lambda aid: b"BILD")
    hochgeladen = []

    def fake_upload(name, content):
        hochgeladen.append(name)
        return "knoten-" + name

    monkeypatch.setattr(comfy_client, "upload_image", fake_upload)
    monkeypatch.setattr(comfy_client, "submit", lambda wf: "prompt-9")

    bild_service.render_edit(COMPANY, {"id": "issue-1"}, EDIT_BRIEF, now=1000.0)

    # aeltester Anhang zuerst -- das ist 'Bild 1'
    assert hochgeladen == ["eins.png", "zwei.png"]
    job = job_state.get("issue-1")
    assert job["prompt_id"] == "prompt-9"
    assert job["sources"] == ["knoten-eins.png", "knoten-zwei.png"]
    assert job["modell"] == "qwenedit"


def test_edit_ohne_anhang_bricht_ab(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    monkeypatch.setattr(bild_service.api, "list_attachments", lambda iid: [])
    monkeypatch.setattr(comfy_client, "submit",
                        lambda wf: pytest.fail("darf nicht abgeschickt werden"))
    bild_service.render_edit(COMPANY, {"id": "issue-1"}, EDIT_BRIEF, now=1000.0)
    assert api.status["issue-1"] == "cancelled"
    assert "Bildanhang" in api.comments[0][1]
    assert job_state.get("issue-1") is None


def test_edit_mit_vier_anhaengen_bricht_ab(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    monkeypatch.setattr(bild_service.api, "list_attachments",
                        lambda iid: [_att(str(n), "2026-08-04T0%d:00:00.000Z" % n)
                                     for n in range(1, 5)])
    monkeypatch.setattr(comfy_client, "submit",
                        lambda wf: pytest.fail("darf nicht abgeschickt werden"))
    bild_service.render_edit(COMPANY, {"id": "issue-1"}, EDIT_BRIEF, now=1000.0)
    assert api.status["issue-1"] == "cancelled"


def test_edit_meldet_ignoriertes_format(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    monkeypatch.setattr(bild_service.api, "list_attachments",
                        lambda iid: [_att("a", "2026-08-04T10:00:00.000Z")])
    monkeypatch.setattr(bild_service.api, "fetch_attachment", lambda aid: b"BILD")
    monkeypatch.setattr(comfy_client, "upload_image", lambda n, c: n)
    monkeypatch.setattr(comfy_client, "submit", lambda wf: "prompt-9")
    brief = dict(EDIT_BRIEF, format_ignored=True)
    bild_service.render_edit(COMPANY, {"id": "issue-1"}, brief, now=1000.0)
    assert any("format" in c[1].lower() for c in api.comments)


def test_process_new_issue_leitet_qwenedit_um(monkeypatch, tmp_path):
    setup(monkeypatch, tmp_path)
    gerufen = []
    monkeypatch.setattr(bild_service, "render_edit",
                        lambda *a, **k: gerufen.append("edit"))
    monkeypatch.setattr(bild_service, "render_local",
                        lambda *a, **k: gerufen.append("local"))
    issue = {"id": "issue-1", "description": "prompt: x\nmodell: qwenedit"}
    bild_service.process_new_issue(COMPANY, issue, now=1000.0)
    assert gerufen == ["edit"]


# --- Review-Fix (Befund 2): die drei Schutzmechanismen gelten auch fuer -----
# --- render_edit -- ohne diese Tests waere das unbelegt geblieben.       ---

def test_edit_warteschlange_voll_kommentiert_einmal_und_schickt_nicht_ab(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    for i in range(config.MAX_INFLIGHT_JOBS):
        job_state.add("other-%d" % i, "prompt-%d" % i, "company-a", now=1000.0)
    monkeypatch.setattr(comfy_client, "submit",
                        lambda wf: pytest.fail("darf nicht abgeschickt werden"))

    bild_service.render_edit(COMPANY, {"id": "issue-1"}, EDIT_BRIEF, now=1000.0)
    bild_service.render_edit(COMPANY, {"id": "issue-1"}, EDIT_BRIEF, now=1060.0)

    assert job_state.get("issue-1") is None
    assert len(api.comments) == 1        # nur einmal, nicht bei jedem Zyklus
    assert "Warteschlange" in api.comments[0][1]


def test_edit_tageslimit_erreicht_bricht_ab_und_schickt_nicht_ab(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    for _ in range(cost_state.DAILY_LOCAL_LIMIT):
        cost_state.record_local("2026-08-02")
    monkeypatch.setattr(bild_service, "_today", lambda: "2026-08-02")
    monkeypatch.setattr(comfy_client, "submit",
                        lambda wf: pytest.fail("darf nicht abgeschickt werden"))

    bild_service.render_edit(COMPANY, {"id": "issue-1"}, EDIT_BRIEF, now=1000.0)

    assert api.status["issue-1"] == "cancelled"
    assert "Tageslimit" in api.comments[0][1]
    assert job_state.get("issue-1") is None


def test_edit_knoten_weg_beim_upload_bleibt_liegen(monkeypatch, tmp_path):
    """Wirft der Knoten waehrend upload_sources() eine ComfyError, muss der
    Auftrag unangetastet liegen bleiben: kein 'cancelled', kein Eintrag in
    job_state, kein hochgezaehlter Tageszaehler -- der naechste Zyklus soll
    ihn ganz normal noch einmal versuchen."""
    api = setup(monkeypatch, tmp_path)
    monkeypatch.setattr(bild_service.api, "list_attachments",
                        lambda iid: [_att("eins", "2026-08-04T10:00:00.000Z")])
    monkeypatch.setattr(bild_service.api, "fetch_attachment", lambda aid: b"BILD")

    def kaputter_upload(name, content):
        raise comfy_client.ComfyError("ComfyUI nicht erreichbar")

    monkeypatch.setattr(comfy_client, "upload_image", kaputter_upload)
    monkeypatch.setattr(comfy_client, "submit",
                        lambda wf: pytest.fail("darf nicht abgeschickt werden"))
    verbleibend_vorher = cost_state.remaining_local_today("2026-08-04")

    bild_service.render_edit(COMPANY, {"id": "issue-1"}, EDIT_BRIEF, now=1000.0)

    assert job_state.get("issue-1") is None
    assert "issue-1" not in api.status
    assert api.comments == []
    assert cost_state.remaining_local_today("2026-08-04") == verbleibend_vorher


def test_wiederholung_nutzt_die_gemerkten_quellen(monkeypatch, tmp_path):
    """Der Dienst haengt sein eigenes Ergebnis ans selbe Issue. Wuerde der
    Wiederholversuch die Anhangsliste neu lesen, bearbeitete er ab dem
    zweiten Versuch sein eigenes Bild -- still und ohne Fehlermeldung."""
    setup(monkeypatch, tmp_path)
    job_state.add("issue-1", "prompt-1", "company-a", now=0.0,
                  seed=42, modell="qwenedit", sources=["quelle.png"])
    monkeypatch.setattr(bild_service.api, "get_issue",
                        lambda iid: {"description": "prompt: x\nmodell: qwenedit"})
    monkeypatch.setattr(bild_service.api, "list_attachments",
                        lambda iid: pytest.fail("Anhänge dürfen NICHT neu gelesen werden"))
    monkeypatch.setattr(comfy_client, "upload_image",
                        lambda n, c: pytest.fail("nichts darf neu hochgeladen werden"))
    monkeypatch.setattr(comfy_client, "poll", lambda pid: ("running", None))
    gesendet = {}

    def fake_submit(wf):
        gesendet["wf"] = wf
        return "prompt-2"

    monkeypatch.setattr(comfy_client, "submit", fake_submit)

    ergebnis = bild_service.collect_one("issue-1", job_state.get("issue-1"), now=700.0)

    assert ergebnis == "timeout"
    assert job_state.get("issue-1")["prompt_id"] == "prompt-2"
    assert gesendet["wf"]["20"]["inputs"]["image"] == "quelle.png"
    assert job_state.get("issue-1")["sources"] == ["quelle.png"]


def test_wiederholung_ohne_quellen_bleibt_der_alte_weg(monkeypatch, tmp_path):
    """Normale qwen-Auftraege haben keine sources und muessen weiterhin
    ueber Breite/Hoehe aus dem Brief neu gebaut werden."""
    setup(monkeypatch, tmp_path)
    job_state.add("issue-1", "prompt-1", "company-a", now=0.0, seed=7, modell="qwen")
    monkeypatch.setattr(bild_service.api, "get_issue",
                        lambda iid: {"description": "prompt: Hirsch\nmodell: qwen"})
    monkeypatch.setattr(comfy_client, "poll", lambda pid: ("running", None))
    gesendet = {}
    monkeypatch.setattr(comfy_client, "submit",
                        lambda wf: (gesendet.update(wf=wf), "prompt-2")[1])
    ergebnis = bild_service.collect_one("issue-1", job_state.get("issue-1"), now=400.0)
    assert ergebnis == "timeout"
    assert gesendet["wf"]["6"]["inputs"]["text"] == "Hirsch"
