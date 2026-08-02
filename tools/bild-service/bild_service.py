#!/usr/bin/env python3
import sys, os, fcntl, datetime, traceback
import config, paperclip_api as api
from brief_parser import parse_brief
from openai_image import generate_png
import cost_state

def _today():
    return datetime.date.today().isoformat()

def process_issue(company, issue):
    iid = issue["id"]
    title = issue.get("title", "")
    # Kein "in_progress"-Lock: Paperclip verlangt dafür einen Assignee, den
    # label-basierte Subtasks nicht haben (422). Doppelverarbeitung wird stattdessen
    # über den flock-Single-Instance-Guard in __main__ verhindert; der Subtask
    # bleibt bis zum Abschluss in todo/backlog und geht dann auf done/cancelled.
    brief = parse_brief(issue.get("description") or title)
    if brief["error"]:
        api.add_comment(iid, f"⚠️ Bild nicht erzeugt: {brief['error']}\n"
                             f"Format:\nprompt: <Beschreibung>\nsize: 1024x1024\nquality: medium")
        api.patch_status(iid, "cancelled")
        return
    if cost_state.remaining_today(_today()) <= 0:
        api.add_comment(iid, f"⚠️ Tageslimit ({config.DAILY_IMAGE_LIMIT} Bilder) erreicht. "
                             f"Morgen erneut versuchen.")
        api.patch_status(iid, "cancelled")
        return
    # Monatsbudget-Deckel: projizierte Kosten dieses Bildes dürfen den Deckel nicht reißen
    month = _today()[:7]
    est_cost = config.COST_ESTIMATE.get(brief["quality"], 0.04)
    if cost_state.monthly_spent(month) + est_cost > config.MONTHLY_BUDGET_USD:
        api.add_comment(iid,
            f"⚠️ Monatsbudget (${config.MONTHLY_BUDGET_USD:.2f}) erreicht — "
            f"bereits ~${cost_state.monthly_spent(month):.2f} verbraucht. "
            f"Nächsten Monat erneut versuchen oder Budget anheben.")
        api.patch_status(iid, "cancelled")
        return
    try:
        png = generate_png(brief)
    except Exception as e:
        api.add_comment(iid, f"⚠️ OpenAI-Fehler: {e}")
        api.patch_status(iid, "cancelled")
        return
    fname = "bild-" + iid[:8] + ".png"
    api.upload_attachment(company["id"], iid, fname, png)
    cost_state.record(_today(), brief["quality"])
    est = config.COST_ESTIMATE.get(brief["quality"], 0.04)
    api.add_comment(iid,
        f"✅ Bild erzeugt (gpt-image-1).\n"
        f"Prompt: {brief['prompt']}\n"
        f"Settings: {brief['size']}, quality={brief['quality']}, bg={brief['background']}\n"
        f"Geschätzte Kosten: ~{est:.2f} USD")
    api.patch_status(iid, "done")

def run_once():
    for company in config.COMPANIES:
        for status in config.POLL_STATUSES:
            try:
                issues = api.list_issues(company["id"], status, company["label"])
            except api.AuthError as e:
                api.mail_alarm("[Bilddienst] Paperclip-Token abgelaufen", str(e))
                sys.exit(1)
            for issue in issues:
                try:
                    process_issue(company, issue)
                except api.AuthError as e:
                    api.mail_alarm("[Bilddienst] Paperclip-Token abgelaufen", str(e))
                    sys.exit(1)
                except Exception:
                    api.mail_alarm("[Bilddienst] Unerwarteter Fehler", traceback.format_exc())

def main():
    # Single-Instance-Guard: verhindert, dass sich zwei Läufe überlappen und
    # denselben (noch nicht terminalen) Subtask doppelt verarbeiten.
    lock_path = os.path.join(os.path.dirname(config.STATE_FILE), "bild-service.lock")
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    lock_fd = open(lock_path, "w")
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit(0)  # anderer Lauf aktiv -> still beenden
    try:
        run_once()
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        lock_fd.close()

if __name__ == "__main__":
    main()
