from config import (STATE_FILE as _DEFAULT_STATE, DAILY_IMAGE_LIMIT,
                    COST_ESTIMATE, DAILY_LOCAL_LIMIT)
import state_io

STATE_FILE = _DEFAULT_STATE

def monthly_spent(month_str):
    """Summe der geschätzten Kosten (USD) aller Tage im Monat 'YYYY-MM'."""
    st = _load()
    return round(sum(day.get("cost_usd", 0.0)
                     for k, day in st.items() if k.startswith(month_str)), 4)

def _load():
    return state_io.load(STATE_FILE)

def _save(state):
    state_io.save(STATE_FILE, state)

def remaining_today(date_str):
    st = _load()
    day = st.get(date_str, {})
    return DAILY_IMAGE_LIMIT - int(day.get("count", 0))

def record(date_str, quality):
    st = _load()
    day = st.setdefault(date_str, {"count": 0, "cost_usd": 0.0})
    day["count"] += 1
    day["cost_usd"] = round(day["cost_usd"] + COST_ESTIMATE.get(quality, 0.04), 4)
    _prune(st)
    _save(st)


def _is_day_key(key):
    return len(key) == 10 and key[4] == "-" and key[7] == "-"


def _prune(state):
    """Nur Datumsschluessel beschneiden — 'jobs' und kuenftige Schluessel bleiben."""
    days = sorted(k for k in state if _is_day_key(k))
    for k in days[:-31]:
        del state[k]


def record_local(date_str):
    st = _load()
    day = st.setdefault(date_str, {"count": 0, "cost_usd": 0.0})
    day["local_count"] = int(day.get("local_count", 0)) + 1
    _prune(st)
    _save(st)


def remaining_local_today(date_str):
    day = _load().get(date_str, {})
    return DAILY_LOCAL_LIMIT - int(day.get("local_count", 0))
