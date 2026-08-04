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
import sources as src
import workflow_template as wt
from brief_parser import parse_brief
from openai_image import generate_png

FORMAT_HINT = ("Format:\n"
               "prompt: <Beschreibung>\n"
               "modell: qwen | qwen360 | qwenedit | openai\n"
               "format: 1024x1024   (bei qwen360: 2048x1024; bei qwenedit: entfällt)\n"
               "seed: 42\n"
               "\n"
               "modell: qwen360 erzeugt ein 360-Grad-Panorama in "
               "equirektangularer Projektion (2:1). Das Auslösewort steht "
               "bereits in der Vorlage — der Prompt beschreibt nur die Szene.\n"
               "modell: qwenedit bearbeitet ein bis drei Bilder, die als "
               "Anhang am Issue hängen; im Prompt heißen sie Bild 1, Bild 2, Bild 3.")


def _workflow_name(modell):
    """Vorlagenname zum Modell. Unbekanntes Modell faellt bewusst auf die
    Standardvorlage zurueck, weil der Brief-Parser ohnehin nur bekannte
    Modelle durchlaesst."""
    return config.LOCAL_WORKFLOWS.get(modell, config.LOCAL_WORKFLOWS["qwen"])


def _job_timeout(modell):
    return config.MODEL_JOB_TIMEOUT_SEC.get(modell, config.JOB_TIMEOUT_SEC)

def _today():
    return datetime.date.today().isoformat()


def reset_unreachable_counter():
    """Zaehler und Alarmiert-Flag zuruecksetzen.

    Liegen persistent in job_state (State-File), NICHT als Modul-Globals:
    launchd startet den Dienst per StartInterval ohne KeepAlive, also ist
    jeder Zyklus ein frischer Prozess. Modul-Globals wuerden bei jedem Start
    auf 0 zurueckfallen und die Alarmschwelle (UNREACHABLE_ALERT_CYCLES)
    nie erreichen -- siehe job_state.py fuer die Details.
    """
    job_state.reset_unreachable()


# --- Absenden ------------------------------------------------------------

def _local_guards_block(iid):
    """-> True, wenn der Auftrag JETZT nicht laufen darf.

    Warteschlange und Tageslimit gelten fuer JEDEN lokalen Renderpfad. Sie
    liegen hier gemeinsam, damit eine Aenderung nicht in einem der beiden
    Pfade vergessen wird.
    """
    if len(job_state.all()) >= config.MAX_INFLIGHT_JOBS:
        # Knoten voll: Auftrag bleibt liegen, naechster Zyklus versucht erneut.
        # blockParentUntilDone haengt die ordernde Agentin sonst ohne jedes
        # Signal auf -- einmalig kommentieren, aber NICHT bei jedem Zyklus,
        # sonst waere der Kommentarspam schlimmer als die Stille.
        if not job_state.has_queue_notice(iid):
            api.add_comment(iid, "⏳ Warteschlange voll (max. %d gleichzeitige lokale Renders). "
                                 "Auftrag wird gerendert, sobald ein Platz frei wird."
                                 % config.MAX_INFLIGHT_JOBS)
            job_state.mark_queue_notice(iid)
        return True
    if cost_state.remaining_local_today(_today()) <= 0:
        api.add_comment(iid, "⚠️ Tageslimit (%d lokale Bilder) erreicht. "
                             "Morgen erneut versuchen." % config.DAILY_LOCAL_LIMIT)
        api.patch_status(iid, "cancelled")
        return True
    return False


def _submit_local_job(iid, company, workflow, seed, modell, now, sources=None):
    """Workflow abschicken und bei Erfolg registrieren.

    Gemeinsamer Abschluss aller lokalen Renderpfade: submit, Registrierung in
    job_state, Warteschlangen-Marker loeschen, Tageszaehler hochzaehlen. Bei
    ComfyError bleibt der Auftrag unregistriert liegen -- der naechste
    Zyklus versucht es erneut.
    """
    try:
        prompt_id = comfy_client.submit(workflow)
    except comfy_client.ComfyError:
        return None
    job_state.add(iid, prompt_id, company["id"], now, seed=seed, modell=modell, sources=sources)
    job_state.clear_queue_notice(iid)
    cost_state.record_local(_today())
    return prompt_id


def render_local(company, issue, brief, now):
    iid = issue["id"]
    if _local_guards_block(iid):
        return
    seed = brief["seed"] if brief["seed"] is not None else random.randint(1, 2 ** 31 - 1)
    workflow = wt.fill(wt.load_raw(_workflow_name(brief["modell"])), brief["prompt"],
                       seed, brief["width"], brief["height"])
    _submit_local_job(iid, company, workflow, seed, brief["modell"], now)


def upload_sources(issue_id):
    """Quellbilder des Issues auf den Knoten legen.

    -> (names, error). names sind die vom Knoten vergebenen Dateinamen in der
    Reihenfolge 'Bild 1..3'. Bei error ist nichts abzuschicken.
    """
    bilder, fehler = src.pick_source_images(api.list_attachments(issue_id))
    if fehler:
        return [], fehler
    namen = []
    for att in bilder:
        daten = api.fetch_attachment(att["id"])
        namen.append(comfy_client.upload_image(
            att.get("originalFilename") or (att["id"] + ".png"), daten))
    return namen, None


def render_edit(company, issue, brief, now):
    iid = issue["id"]
    if _local_guards_block(iid):
        return
    if brief["format_ignored"]:
        api.add_comment(iid, "ℹ️ Das angegebene 'format' wird bei modell: qwenedit "
                             "ignoriert — die Ausgabegröße folgt dem ersten Quellbild.")
    try:
        namen, fehler = upload_sources(iid)
    except comfy_client.ComfyError:
        return          # Knoten weg: Auftrag bleibt liegen, naechster Zyklus versucht erneut
    if fehler:
        api.add_comment(iid, "⚠️ Bild nicht erzeugt: %s" % fehler)
        api.patch_status(iid, "cancelled")
        return
    seed = brief["seed"] if brief["seed"] is not None else random.randint(1, 2 ** 31 - 1)
    workflow = wt.set_images(
        wt.fill(wt.load_raw(_workflow_name(brief["modell"])), brief["prompt"], seed),
        namen)
    _submit_local_job(iid, company, workflow, seed, brief["modell"], now, sources=namen)


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
    elif brief["modell"] in config.EDIT_MODELS:
        render_edit(company, issue, brief, now)
    else:
        render_local(company, issue, brief, now)


# --- Einsammeln ----------------------------------------------------------

def _brief_for_issue(job):
    """Brief eines laufenden Auftrags neu einlesen (fuer den Wiederholversuch)."""
    issue = api.get_issue(job["issue_id"])
    return parse_brief(issue.get("description") or issue.get("title", ""))


def collect_one(issue_id, job, now):
    # Absoluter Notausstieg (Finding 2): wenn die 'done'-Verarbeitung weiter
    # unten (fetch_image/upload_attachment/add_comment/patch_status) an
    # irgendeiner Stelle scheitert, wird job_state.drop() nie erreicht -- der
    # Knoten meldet beim naechsten Zyklus wieder 'done', und derselbe Schritt
    # scheitert erneut, auf ewig. Deshalb VOR jeder Status-Verzweigung
    # pruefen: ein Job, der laenger als das Vielfache von JOB_TIMEOUT_SEC lebt,
    # wird zwangsweise abgebrochen, egal was der Knoten gerade meldet.
    timeout_sec = _job_timeout(job.get("modell"))
    stuck_ceiling = timeout_sec * config.STUCK_JOB_AGE_MULTIPLIER
    if job_state.age_seconds(job, now) > stuck_ceiling:
        api.add_comment(issue_id,
                        "⚠️ Auftrag hängt seit über %d s fest und wurde zwangsweise "
                        "abgebrochen." % stuck_ceiling)
        api.patch_status(issue_id, "cancelled")
        job_state.drop(issue_id)
        api.mail_alarm("[Bilddienst] Auftrag hängengeblieben",
                       "Issue %s, prompt_id %s hängt seit über %d s fest (vermutlich "
                       "wiederholt gescheiterte Verarbeitung eines 'done'-Ergebnisses) "
                       "und wurde zwangsweise abgebrochen."
                       % (issue_id, job["prompt_id"], stuck_ceiling))
        return "error"

    try:
        status, payload = comfy_client.poll(job["prompt_id"])
    except comfy_client.ComfyError:
        return "running"        # Knoten weg: nichts entscheiden, spaeter erneut

    if status == "done":
        # Finding 3: idempotent machen. upload_attachment() kann erfolgreich
        # sein, aber add_comment()/patch_status() danach scheitern (z.B.
        # Paperclip-Restart per launchctl kickstart mittendrin) -- der
        # naechste Zyklus pollt wieder 'done' und darf das PNG nicht ein
        # zweites Mal hochladen.
        if not job.get("uploaded"):
            png = comfy_client.fetch_image(payload[0])
            api.upload_attachment(job["company_id"], issue_id,
                                  "bild-%s.png" % issue_id[:8], png)
            job_state.mark_uploaded(issue_id)
        modell = job.get("modell")
        if modell == "qwen360":
            label = "Qwen-Image 2512 + 360-LoRA, equirektangular"
        elif modell == "qwenedit":
            label = "Qwen-Image-Edit 2511, %d Quellbild(er)" % len(job.get("sources") or [])
        else:
            label = "Qwen-Image 2512"
        api.add_comment(issue_id,
                        "✅ Bild erzeugt (%s, lokal).\n"
                        "Seed: %s\nDauer: %.0f s"
                        % (label, job.get("seed", "—"),
                           job_state.age_seconds(job, now)))
        api.patch_status(issue_id, "done")
        job_state.drop(issue_id)
        return "done"

    if status == "error":
        api.add_comment(issue_id, "⚠️ ComfyUI-Fehler: %s" % payload)
        api.patch_status(issue_id, "cancelled")
        job_state.drop(issue_id)
        return "error"

    if job_state.age_seconds(job, now) > timeout_sec:
        if int(job.get("attempts", 1)) < 2:
            brief = _brief_for_issue(dict(job, issue_id=issue_id))
            # Finding 4: die Beschreibung kann waehrend des Renderns geleert
            # oder kaputt bearbeitet worden sein -- parse_brief() liefert
            # dann einen Fehler und prompt=None. Ohne diese Pruefung wuerde
            # workflow_template.fill() mit json.dumps(None)[1:-1] == 'ul'
            # ein Bild des Worts "ul" rendern und als 'done' schliessen.
            if brief["error"]:
                api.add_comment(issue_id,
                                "⚠️ Bild nicht erzeugt: %s\n%s" % (brief["error"], FORMAT_HINT))
                api.patch_status(issue_id, "cancelled")
                job_state.drop(issue_id)
                return "error"
            seed = brief["seed"] if brief["seed"] is not None else random.randint(1, 2 ** 31 - 1)
            workflow = wt.fill(wt.load_raw(_workflow_name(brief["modell"])),
                               brief["prompt"], seed,
                               brief["width"], brief["height"])
            try:
                new_id = comfy_client.submit(workflow)
            except comfy_client.ComfyError:
                return "running"
            job_state.bump_attempt(issue_id, new_id, now, seed=seed)
            return "timeout"
        api.add_comment(issue_id,
                        "⚠️ Render nach zwei Versuchen ohne Ergebnis "
                        "(je über %d s). Auftrag abgebrochen." % timeout_sec)
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
    cycles = job_state.increment_unreachable_cycles()
    if cycles < config.UNREACHABLE_ALERT_CYCLES or job_state.is_unreachable_alerted():
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
                       % (config.COMFY_BASE, cycles, len(waiting)))
    except api.AuthError:
        raise            # Token-Ablauf gehoert nach oben, nicht verschluckt
    except Exception:
        return           # Sperre bleibt offen -> naechster Zyklus versucht es erneut
    job_state.set_unreachable_alerted(True)


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
