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


def _bump_failure_or_cancel(iid, reason):
    """Gemeinsame Zaehler-Mechanik fuer Befund 2 und 3: ein Fehler beim
    Absenden/Hochladen fuer dieses Issue wird gezaehlt statt sofort
    abzubrechen -- ein einzelner Ausrutscher bleibt folgenlos. Erst nach
    FAILED_SUBMIT_CANCEL_CYCLES aufeinanderfolgenden Fehlern gilt der
    Auftrag als dauerhaft kaputt und wird beendet.
    """
    versuche = job_state.record_failed_submit(iid)
    if versuche < config.FAILED_SUBMIT_CANCEL_CYCLES:
        return
    api.add_comment(iid, "⚠️ %s\nNach %d aufeinanderfolgenden Versuchen abgebrochen."
                    % (reason, versuche))
    api.patch_status(iid, "cancelled")
    job_state.clear_failed_submits(iid)
    api.mail_alarm("[Bilddienst] Auftrag dauerhaft fehlgeschlagen",
                   "Issue %s: %d aufeinanderfolgende Fehlversuche. %s"
                   % (iid, versuche, reason))


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
        # Befund 2: ist der Knoten insgesamt weg, ist das Sache von
        # note_unreachable() -- der Auftrag bleibt dort BEWUSST unbegrenzt in
        # der Warteschlange liegen. Nur wenn der Knoten erreichbar ist,
        # /prompt das Absenden aber trotzdem ablehnt (z.B. eine umbenannte
        # Modelldatei), zaehlt der Fehlversuch -- sonst wuerde ein simpler
        # Knoten-Neustart Auftraege faelschlich als 'dauerhaft ungueltig'
        # abbrechen.
        if comfy_client.health():
            _bump_failure_or_cancel(iid,
                "Absenden an den Renderknoten scheitert, obwohl er erreichbar "
                "ist (vermutlich ein dauerhaft ungültiger Workflow, z.B. eine "
                "umbenannte Modelldatei).")
        return None
    job_state.add(iid, prompt_id, company["id"], now, seed=seed, modell=modell, sources=sources)
    job_state.clear_queue_notice(iid)
    job_state.clear_failed_submits(iid)
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
    except api.PaperclipUnreachable:
        # Ist :3100 als Ganzes weg, ist das KEIN Fehlversuch dieses Auftrags,
        # sondern Sache der zentralen Daempfung (note_paperclip_unreachable) --
        # genau wie ein komplett weggefallener Renderknoten in
        # _submit_local_job. Wuerde es hier zaehlen, kaeme ein 10-minuetiger
        # Neustart von :3100 einem Abbruch des Auftrags gleich.
        raise
    except api.PaperclipError:
        # Befund 3: list_attachments()/fetch_attachment() koennen genauso an
        # Paperclip scheitern (Asset geloescht, Storage antwortet 500) wie
        # der Knoten. Unbehandelt liefe das bis submit_phase durch und
        # loeste dort JEDEN Zyklus eine Alarmmail aus, ohne dass der Auftrag
        # je endet. AuthError erbt NICHT von PaperclipError und schlaegt
        # bewusst weiter nach oben durch -- der Dienst beendet sich dann
        # (siehe run_once), statt mit abgelaufenem Token weiterzulaufen.
        _bump_failure_or_cancel(iid,
            "Quellbilder konnten nicht von Paperclip geladen werden "
            "(z.B. ein gelöschtes Asset oder ein Storage-Fehler).")
        return
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
    api.upload_attachment(company["id"], iid, config.output_filename(iid), png)
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
                                  config.output_filename(issue_id), png)
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
            raw = wt.load_raw(_workflow_name(brief["modell"]))
            quellen = job.get("sources") or []
            if quellen:
                # Bewusst die GEMERKTEN Quellen, nicht die Anhangsliste: das
                # Ergebnis-PNG des ersten Versuchs haengt inzwischen selbst am
                # Issue und wuerde sonst zum Quellbild.
                workflow = wt.set_images(wt.fill(raw, brief["prompt"], seed), quellen)
            else:
                workflow = wt.fill(raw, brief["prompt"], seed,
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


def note_paperclip_unreachable(err):
    """Zyklus an einem toten :3100 gescheitert -- gedaempft melden.

    Ohne Daempfung mailt der Dienst im Minutentakt (Vorfall 21.08.: :3100 lag
    stundenlang im Crashloop). Zaehler und Alarmiert-Flag liegen aus demselben
    Grund wie beim Renderknoten im State-File und nicht in Modul-Globals:
    launchd startet jeden Zyklus als frischen Prozess.
    """
    cycles = job_state.increment_paperclip_unreachable_cycles()
    if cycles < config.PAPERCLIP_UNREACHABLE_ALERT_CYCLES:
        return
    if job_state.is_paperclip_unreachable_alerted():
        return
    api.mail_alarm("[Bilddienst] Paperclip nicht erreichbar",
                   "Paperclip auf %s antwortet seit %d Zyklen (je 60 s) nicht.\n"
                   "Der Bilddienst kann weder Aufträge lesen noch Ergebnisse "
                   "abliefern; laufende Renders bleiben in der Warteschlange.\n\n"
                   "Diese Meldung kommt genau einmal je Ausfall — die nächste "
                   "erst wieder, wenn :3100 zwischendurch zurück war.\n\n"
                   "Letzter Fehler:\n%s"
                   % (config.PAPERCLIP_BASE, cycles, err))
    job_state.set_paperclip_unreachable_alerted(True)


def reset_paperclip_unreachable():
    """Nach einem sauber durchgelaufenen Zyklus: Zaehler zurueck, und einmal
    Entwarnung geben, falls vorher wirklich alarmiert wurde."""
    if job_state.is_paperclip_unreachable_alerted():
        api.mail_alarm("[Bilddienst] Paperclip wieder erreichbar",
                       "Paperclip auf %s antwortet wieder, der Bilddienst "
                       "arbeitet normal weiter." % config.PAPERCLIP_BASE)
    elif not job_state.paperclip_unreachable_cycles():
        return          # nichts zu tun -- spart den Schreibzugriff je Zyklus
    job_state.reset_paperclip_unreachable()


# --- Zyklus --------------------------------------------------------------

def collect_phase(now):
    for issue_id, job in list(job_state.all().items()):
        try:
            collect_one(issue_id, job, now)
        except (api.AuthError, api.PaperclipUnreachable):
            # Ist :3100 ganz weg, scheitert JEDER Job an derselben Ursache --
            # das ist ein Zyklusproblem, keins dieses einen Auftrags. Hier
            # abgefangen gaebe es eine Mail pro Job und Minute.
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
                except (api.AuthError, api.PaperclipUnreachable):
                    raise       # siehe collect_phase
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
    except api.PaperclipUnreachable as e:
        note_paperclip_unreachable(e)
        return
    except Exception:
        api.mail_alarm("[Bilddienst] Zyklus abgebrochen", traceback.format_exc())
        return
    reset_paperclip_unreachable()


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
