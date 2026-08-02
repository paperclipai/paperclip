"""Warteschlange laufender ComfyUI-Renders, neustartfest.

Liegt im selben State-File wie die Kostenzaehler, aber unter dem eigenen
Schluessel 'jobs' — die Datumsschluessel von cost_state bleiben unberuehrt.
"""
import json
import os
import tempfile

from config import STATE_FILE as _DEFAULT_STATE

STATE_FILE = _DEFAULT_STATE

JOBS_KEY = "jobs"


def _load():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(STATE_FILE))
    with os.fdopen(fd, "w") as f:
        json.dump(state, f)
    os.replace(tmp, STATE_FILE)


def all():
    return _load().get(JOBS_KEY, {})


def get(issue_id):
    return all().get(issue_id)


def add(issue_id, prompt_id, company_id, now, seed=None):
    st = _load()
    jobs = st.setdefault(JOBS_KEY, {})
    jobs[issue_id] = {"prompt_id": prompt_id, "company_id": company_id,
                      "submitted_at": now, "attempts": 1, "seed": seed}
    _save(st)


def bump_attempt(issue_id, prompt_id, now):
    st = _load()
    jobs = st.setdefault(JOBS_KEY, {})
    job = jobs.get(issue_id)
    if job is None:
        return 0
    job["attempts"] = int(job.get("attempts", 1)) + 1
    job["prompt_id"] = prompt_id
    job["submitted_at"] = now
    _save(st)
    return job["attempts"]


def drop(issue_id):
    st = _load()
    jobs = st.get(JOBS_KEY, {})
    if issue_id in jobs:
        del jobs[issue_id]
        _save(st)


def age_seconds(job, now):
    return now - float(job.get("submitted_at", 0))
