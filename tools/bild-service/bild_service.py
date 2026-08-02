#!/usr/bin/env python3
import datetime
import fcntl
import os
import random
import sys
import time
import traceback

import comfy_client
import config
import cost_state
import job_state
import paperclip_api as api
import workflow_template as wt
from brief_parser import parse_brief
from openai_image import generate_png

FORMAT_HINT = ("Format:\n"
               "prompt: <Beschreibung>\n"
               "modell: qwen | openai\n"
               "format: 1024x1024\n"
               "seed: 42")

_unreachable_cycles = 0
_unreachable_alerted = False


def _today():
    return datetime.date.today().isoformat()


def reset_unreachable_counter():
    global _unreachable_cycles, _unreachable_alerted
    _unreachable_cycles = 0
    _unreachable_alerted = False


# --- Absenden ------------------------------------------------------------

def render_local(company, issue, brief, now):
    iid = issue["id"]
    if len(job_state.all()) >= config.MAX_INFLIGHT_JOBS:
        return          # Knoten voll: Auftrag bleibt liegen, naechster Zyklus versucht erneut
    if cost_state.remaining_local_today(_today()) <= 0:
        api.add_comment(iid, "⚠️ Tageslimit (%d lokale Bilder) erreicht. "
                             "Morgen erneut versuchen." % config.DAILY_LOCAL_LIMIT)
        api.patch_status(iid, "cancelled")
        return
    seed = brief["seed"] if brief["seed"] is not None else random.randint(1, 2 ** 31 - 1)
    workflow = wt.fill(wt.load_raw("qwen-image"), brief["prompt"], seed,
                       brief["width"], brief["height"])
    try:
        prompt_id = comfy_client.submit(workflow)
    except comfy_client.ComfyError:
        return          # Knoten weg: Auftrag bleibt liegen, naechster Zyklus versucht erneut
    job_state.add(iid, prompt_id, company["id"], now, seed=seed)
    cost_state.record_local(_today())


def render_openai(company, issue, brief):
    iid = issue["id"]
    if cost_state.remaining_today(_today()) <= 0:
        api.add_comment(iid, "⚠️ Tageslimit (%d Bilder) erreicht. "
                             "Morgen erneut versuchen." % config.DAILY_IMAGE_LIMIT)
        api.patch_status(iid, "cancelled")
        return
    month = _today()[:7]
    est = config.COST_ESTIMATE.get(brief["quality"], 0.04)
    if cost_state.monthly_spent(month) + est > config.MONTHLY_BUDGET_USD:
        api.add_comment(iid, "⚠️ Monatsbudget ($%.2f) erreicht — bereits ~$%.2f verbraucht."
                        % (config.MONTHLY_BUDGET_USD, cost_state.monthly_spent(month)))
        api.patch_status(iid, "cancelled")
        return
    openai_brief = dict(brief, size=brief["openai_size"])
    try:
        png = generate_png(openai_brief)
    except Exception as e:
        api.add_comment(iid, "⚠️ OpenAI-Fehler: %s" % e)
        api.patch_status(iid, "cancelled")
        return
    api.upload_attachment(company["id"], iid, "bild-%s.png" % iid[:8], png)
    cost_state.record(_today(), brief["quality"])
    note = ""
    if brief["openai_size"] != brief["size"]:
        note = "\nHinweis: %s kennt die OpenAI-API nicht, gerendert wurde %s." % (
            brief["size"], brief["openai_size"])
    api.add_comment(iid,
                    "✅ Bild erzeugt (gpt-image-1).\nPrompt: %s\n"
                    "Einstellungen: %s, quality=%s, bg=%s\n"
                    "Geschätzte Kosten: ~%.2f USD%s"
                    % (brief["prompt"], brief["openai_size"], brief["quality"],
                       brief["background"], est, note))
    api.patch_status(iid, "done")


def process_new_issue(company, issue, now):
    iid = issue["id"]
    brief = parse_brief(issue.get("description") or issue.get("title", ""))
    if brief["error"]:
        api.add_comment(iid, "⚠️ Bild nicht erzeugt: %s\n%s" % (brief["error"], FORMAT_HINT))
        api.patch_status(iid, "cancelled")
        return
    if brief["modell"] == "openai":
        render_openai(company, issue, brief)
    else:
        render_local(company, issue, brief, now)


# --- Einsammeln ----------------------------------------------------------

def _brief_for_issue(job):
    """Brief eines laufenden Auftrags neu einlesen (fuer den Wiederholversuch)."""
    issue = api.get_issue(job["issue_id"])
    return parse_brief(issue.get("description") or issue.get("title", ""))


def collect_one(issue_id, job, now):
    try:
        status, payload = comfy_client.poll(job["prompt_id"])
    except comfy_client.ComfyError:
        return "running"        # Knoten weg: nichts entscheiden, spaeter erneut

    if status == "done":
        png = comfy_client.fetch_image(payload[0])
        api.upload_attachment(job["company_id"], issue_id,
                              "bild-%s.png" % issue_id[:8], png)
        api.add_comment(issue_id,
                        "✅ Bild erzeugt (Qwen-Image 2512, lokal).\n"
                        "Seed: %s\nDauer: %.0f s"
                        % (job.get("seed", "—"), job_state.age_seconds(job, now)))
        api.patch_status(issue_id, "done")
        job_state.drop(issue_id)
        return "done"

    if status == "error":
        api.add_comment(issue_id, "⚠️ ComfyUI-Fehler: %s" % payload)
        api.patch_status(issue_id, "cancelled")
        job_state.drop(issue_id)
        return "error"

    if job_state.age_seconds(job, now) > config.JOB_TIMEOUT_SEC:
        if int(job.get("attempts", 1)) < 2:
            brief = _brief_for_issue(dict(job, issue_id=issue_id))
            seed = brief["seed"] if brief["seed"] is not None else random.randint(1, 2 ** 31 - 1)
            workflow = wt.fill(wt.load_raw("qwen-image"), brief["prompt"], seed,
                               brief["width"], brief["height"])
            try:
                new_id = comfy_client.submit(workflow)
            except comfy_client.ComfyError:
                return "running"
            job_state.bump_attempt(issue_id, new_id, now, seed=seed)
            return "timeout"
        api.add_comment(issue_id,
                        "⚠️ Render nach zwei Versuchen ohne Ergebnis "
                        "(je über %d s). Auftrag abgebrochen." % config.JOB_TIMEOUT_SEC)
        api.patch_status(issue_id, "cancelled")
        job_state.drop(issue_id)
        api.mail_alarm("[Bilddienst] Render zweimal ohne Ergebnis",
                       "Issue %s, prompt_id %s" % (issue_id, job["prompt_id"]))
        return "error"

    return "running"


# --- Knoten nicht erreichbar --------------------------------------------

def _waiting_issues():
    out = []
    for company in config.COMPANIES:
        for status in config.POLL_STATUSES:
            for issue in api.list_issues(company["id"], status, company["label"]):
                out.append((company["id"], issue["id"]))
    return out


def note_unreachable():
    global _unreachable_cycles, _unreachable_alerted
    _unreachable_cycles += 1
    if _unreachable_cycles < config.UNREACHABLE_ALERT_CYCLES or _unreachable_alerted:
        return
    try:
        waiting = _waiting_issues()
        for _company_id, issue_id in waiting:
            api.add_comment(issue_id,
                            "⚠️ Renderknoten seit über %d Minuten nicht erreichbar. "
                            "Der Auftrag bleibt in der Warteschlange."
                            % config.UNREACHABLE_ALERT_CYCLES)
        api.mail_alarm("[Bilddienst] Renderknoten nicht erreichbar",
                       "ComfyUI auf %s antwortet seit %d Zyklen nicht. "
                       "Wartende Aufträge: %d"
                       % (config.COMFY_BASE, _unreachable_cycles, len(waiting)))
    except api.AuthError:
        raise            # Token-Ablauf gehoert nach oben, nicht verschluckt
    except Exception:
        return           # Sperre bleibt offen -> naechster Zyklus versucht es erneut
    _unreachable_alerted = True


# --- Zyklus --------------------------------------------------------------

def collect_phase(now):
    for issue_id, job in list(job_state.all().items()):
        try:
            collect_one(issue_id, job, now)
        except api.AuthError:
            raise
        except Exception:
            api.mail_alarm("[Bilddienst] Fehler beim Einsammeln", traceback.format_exc())


def submit_phase(now):
    for company in config.COMPANIES:
        for status in config.POLL_STATUSES:
            for issue in api.list_issues(company["id"], status, company["label"]):
                if job_state.get(issue["id"]):
                    continue
                try:
                    process_new_issue(company, issue, now)
                except api.AuthError:
                    raise
                except Exception:
                    api.mail_alarm("[Bilddienst] Unerwarteter Fehler", traceback.format_exc())


def run_once(now):
    try:
        if not comfy_client.health():
            note_unreachable()
        else:
            reset_unreachable_counter()
        collect_phase(now)
        submit_phase(now)
    except api.AuthError as e:
        api.mail_alarm("[Bilddienst] Paperclip-Token abgelaufen", str(e))
        sys.exit(1)
    except Exception:
        api.mail_alarm("[Bilddienst] Zyklus abgebrochen", traceback.format_exc())


def main():
    lock_path = os.path.join(os.path.dirname(config.STATE_FILE), "bild-service.lock")
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    lock_fd = open(lock_path, "w")
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit(0)
    try:
        run_once(time.time())
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        lock_fd.close()


if __name__ == "__main__":
    main()
