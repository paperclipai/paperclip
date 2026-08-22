"""Warteschlange laufender ComfyUI-Renders, neustartfest.

Liegt im selben State-File wie die Kostenzaehler, aber unter dem eigenen
Schluessel 'jobs' — die Datumsschluessel von cost_state bleiben unberuehrt.
"""
from config import STATE_FILE as _DEFAULT_STATE
import state_io

STATE_FILE = _DEFAULT_STATE

JOBS_KEY = "jobs"


def _load():
    return state_io.load(STATE_FILE)


def _save(state):
    state_io.save(STATE_FILE, state)


def all():
    return _load().get(JOBS_KEY, {})


def get(issue_id):
    return all().get(issue_id)


def add(issue_id, prompt_id, company_id, now, seed=None, modell=None, sources=None):
    # 'modell' wird mitgeschrieben, weil der Einsammler den Auftrag sonst
    # nicht mehr zuordnen kann: Timeout und Wiederholversuch haengen am
    # Modell, der Brief kann bis dahin aber schon veraendert worden sein.
    # 'sources' sind die auf dem Knoten liegenden Quellbilder. Sie MUESSEN
    # hier stehen: der Dienst haengt sein eigenes Ergebnis an dasselbe Issue,
    # ein Wiederholversuch wuerde die Anhangsliste sonst erneut lesen und ab
    # dem zweiten Versuch das eigene Ergebnis weiterbearbeiten.
    st = _load()
    jobs = st.setdefault(JOBS_KEY, {})
    jobs[issue_id] = {"prompt_id": prompt_id, "company_id": company_id,
                      "submitted_at": now, "attempts": 1, "seed": seed,
                      "modell": modell, "sources": list(sources or [])}
    _save(st)


def bump_attempt(issue_id, prompt_id, now, seed=None):
    st = _load()
    jobs = st.setdefault(JOBS_KEY, {})
    job = jobs.get(issue_id)
    if job is None:
        return 0
    job["attempts"] = int(job.get("attempts", 1)) + 1
    job["prompt_id"] = prompt_id
    job["submitted_at"] = now
    if seed is not None:
        job["seed"] = seed
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


def mark_uploaded(issue_id):
    """Nach erfolgreichem upload_attachment() vermerken, damit ein Replay des
    'done'-Pfads (z.B. weil add_comment/patch_status danach scheitert) das
    Bild nicht ein zweites Mal hochlaedt."""
    st = _load()
    jobs = st.get(JOBS_KEY, {})
    job = jobs.get(issue_id)
    if job is not None:
        job["uploaded"] = True
        _save(st)


# --- Warteschlange-Hinweis (Finding 5): einmaliger Kommentar bei vollem Knoten ---

QUEUE_NOTICE_KEY = "queue_notices"


def has_queue_notice(issue_id):
    return issue_id in _load().get(QUEUE_NOTICE_KEY, {})


def mark_queue_notice(issue_id):
    st = _load()
    notices = st.setdefault(QUEUE_NOTICE_KEY, {})
    notices[issue_id] = True
    _save(st)


def clear_queue_notice(issue_id):
    st = _load()
    notices = st.get(QUEUE_NOTICE_KEY, {})
    if issue_id in notices:
        del notices[issue_id]
        _save(st)


# --- Renderknoten nicht erreichbar (Finding 1): Zaehler ueberlebt Neustarts ---
#
# launchd startet den Dienst per StartInterval ohne KeepAlive -- jeder Zyklus
# ist ein frischer Python-Prozess. Modul-Globals in bild_service.py wuerden
# bei jedem Start auf 0 zurueckfallen und die Alarmschwelle nie erreichen.
# Deshalb leben Zaehler und Alarmiert-Flag hier im selben State-File.

UNREACHABLE_KEY = "unreachable"


def _unreachable_node(state):
    return state.get(UNREACHABLE_KEY, {"cycles": 0, "alerted": False})


def unreachable_cycles():
    return int(_unreachable_node(_load()).get("cycles", 0))


def is_unreachable_alerted():
    return bool(_unreachable_node(_load()).get("alerted", False))


def increment_unreachable_cycles():
    st = _load()
    node = st.setdefault(UNREACHABLE_KEY, {"cycles": 0, "alerted": False})
    node["cycles"] = int(node.get("cycles", 0)) + 1
    _save(st)
    return node["cycles"]


def set_unreachable_alerted(value):
    st = _load()
    node = st.setdefault(UNREACHABLE_KEY, {"cycles": 0, "alerted": False})
    node["alerted"] = bool(value)
    _save(st)


def reset_unreachable():
    st = _load()
    st[UNREACHABLE_KEY] = {"cycles": 0, "alerted": False}
    _save(st)


# --- Paperclip selbst nicht erreichbar: derselbe Zaehler noch einmal -------
#
# Getrennt vom Renderknoten-Zaehler oben, weil beide gleichzeitig laufen
# koennen und sich sonst gegenseitig zuruecksetzen wuerden.

PAPERCLIP_UNREACHABLE_KEY = "paperclip_unreachable"


def _paperclip_node(state):
    return state.get(PAPERCLIP_UNREACHABLE_KEY, {"cycles": 0, "alerted": False})


def paperclip_unreachable_cycles():
    return int(_paperclip_node(_load()).get("cycles", 0))


def is_paperclip_unreachable_alerted():
    return bool(_paperclip_node(_load()).get("alerted", False))


def increment_paperclip_unreachable_cycles():
    st = _load()
    node = st.setdefault(PAPERCLIP_UNREACHABLE_KEY, {"cycles": 0, "alerted": False})
    node["cycles"] = int(node.get("cycles", 0)) + 1
    _save(st)
    return node["cycles"]


def set_paperclip_unreachable_alerted(value):
    st = _load()
    node = st.setdefault(PAPERCLIP_UNREACHABLE_KEY, {"cycles": 0, "alerted": False})
    node["alerted"] = bool(value)
    _save(st)


def reset_paperclip_unreachable():
    st = _load()
    st[PAPERCLIP_UNREACHABLE_KEY] = {"cycles": 0, "alerted": False}
    _save(st)


# --- Fehlgeschlagene Absende-/Hochladeversuche (Befund 2 + 3): pro Issue ----
# zaehlen, statt beim ersten Fehler abzubrechen. Ein einzelner Ausrutscher
# (kurzer Netzwerk-Hakler, ComfyUI mitten im Neustart) bleibt so folgenlos;
# erst eine laengere Serie gilt als dauerhaft kaputt (z.B. eine umbenannte
# Modelldatei oder ein geloeschtes Asset). Liegt hier im State-File aus
# demselben Grund wie 'unreachable' oben: launchd startet jeden Zyklus als
# frischen Prozess, Modul-Globals wuerden die Schwelle nie erreichen.

FAILED_SUBMITS_KEY = "failed_submits"


def failed_submit_count(issue_id):
    return int(_load().get(FAILED_SUBMITS_KEY, {}).get(issue_id, 0))


def record_failed_submit(issue_id):
    st = _load()
    counts = st.setdefault(FAILED_SUBMITS_KEY, {})
    counts[issue_id] = int(counts.get(issue_id, 0)) + 1
    _save(st)
    return counts[issue_id]


def clear_failed_submits(issue_id):
    st = _load()
    counts = st.get(FAILED_SUBMITS_KEY, {})
    if issue_id in counts:
        del counts[issue_id]
        _save(st)
