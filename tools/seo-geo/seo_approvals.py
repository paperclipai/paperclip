"""Token-Freigabe-Queue für SEO/GEO-Changesets (spiegelt Lunas approval_queue).

Ein Token-JSON pro Freigabevorgang unter <base_dir>/<token>.json. Atomarer Write
über tmp+rename. now/token injizierbar für deterministische Tests (Prod: os.urandom
+ time.time über die Default-None-Pfade)."""
import json, os, time, tempfile

TTL_SECONDS = 7 * 24 * 3600

def _path(base_dir, token):
    return os.path.join(base_dir, token + ".json")

def _write_atomic(path, data):
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)

def create(base_dir, site, changeset_path, list_path, count, alt_count, chat_id,
           *, token=None, now=None):
    token = token or os.urandom(9).hex()
    now = time.time() if now is None else now
    rec = {"token": token, "site": site, "changeset_path": changeset_path,
           "list_path": list_path, "count": count, "alt_count": alt_count,
           "status": "pending", "note": None, "chat_id": chat_id,
           "created": now, "last_reping": None}
    _write_atomic(_path(base_dir, token), rec)
    return token

def load(base_dir, token):
    try:
        with open(_path(base_dir, token), encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return None

def set_status(base_dir, token, status, *, note=None):
    rec = load(base_dir, token)
    if rec is None:
        return
    rec["status"] = status
    if note is not None:
        rec["note"] = note
    _write_atomic(_path(base_dir, token), rec)

def list_pending(base_dir, *, older_than_hours=None, now=None):
    now = time.time() if now is None else now
    out = []
    if not os.path.isdir(base_dir):
        return out
    for fn in os.listdir(base_dir):
        if not fn.endswith(".json"):
            continue
        rec = load(base_dir, fn[:-5])
        if not rec or rec.get("status") != "pending":
            continue
        age = now - rec.get("created", now)
        if age > TTL_SECONDS:  # abgelaufen gilt als erledigt
            continue
        if older_than_hours is not None and age < older_than_hours * 3600:
            continue
        out.append(rec)
    return out
