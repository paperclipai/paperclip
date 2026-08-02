import json, os, tempfile
from config import STATE_FILE as _DEFAULT_STATE, DAILY_IMAGE_LIMIT, COST_ESTIMATE

STATE_FILE = _DEFAULT_STATE

def monthly_spent(month_str):
    """Summe der geschätzten Kosten (USD) aller Tage im Monat 'YYYY-MM'."""
    st = _load()
    return round(sum(day.get("cost_usd", 0.0)
                     for k, day in st.items() if k.startswith(month_str)), 4)

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

def remaining_today(date_str):
    st = _load()
    day = st.get(date_str, {})
    return DAILY_IMAGE_LIMIT - int(day.get("count", 0))

def record(date_str, quality):
    st = _load()
    day = st.setdefault(date_str, {"count": 0, "cost_usd": 0.0})
    day["count"] += 1
    day["cost_usd"] = round(day["cost_usd"] + COST_ESTIMATE.get(quality, 0.04), 4)
    for k in sorted(st.keys())[:-31]:   # vollen Monat behalten (für monthly_spent)
        del st[k]
    _save(st)
