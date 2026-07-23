"""Freigabe-Queue für Lunas Vier-Augen-Mailversand (eine JSON-Datei je Token)."""
from __future__ import annotations
import json, secrets
from datetime import datetime, timedelta
from pathlib import Path

QUEUE_DIR = Path.home() / ".paperclip" / "state" / "luna-approvals"
_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"  # Base32 ohne 0/1/8/9


def _existing_tokens() -> set[str]:
    if not QUEUE_DIR.is_dir():
        return set()
    return {p.stem for p in QUEUE_DIR.glob("*.json")}


def gen_token(existing: set[str] | None = None) -> str:
    taken = existing if existing is not None else _existing_tokens()
    while True:
        tok = "".join(secrets.choice(_ALPHABET) for _ in range(4))
        if tok not in taken:
            return tok


def _path(token: str) -> Path:
    return QUEUE_DIR / f"{token}.json"


def save(entry: dict) -> None:
    QUEUE_DIR.mkdir(parents=True, exist_ok=True)
    p = _path(entry["token"])
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(entry, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(p)


def load(token: str) -> dict | None:
    p = _path(token)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def create(*, to: str, area: str, subject: str, body_md: str, rendered_html: str,
           original_mail_file: str, approval_subject: str, in_reply_to: str = "") -> str:
    token = gen_token()
    entry = {
        "token": token, "status": "pending", "to": to, "area": area,
        "subject": subject, "body_md": body_md, "rendered_html": rendered_html,
        "in_reply_to": in_reply_to, "original_mail_file": original_mail_file,
        "approval_subject": approval_subject,
        "created": datetime.now().isoformat(), "sent": None,
    }
    save(entry)
    return token


def list_pending() -> list[dict]:
    if not QUEUE_DIR.is_dir():
        return []
    out = []
    for p in sorted(QUEUE_DIR.glob("*.json")):
        e = load(p.stem)
        if e and e.get("status") == "pending":
            out.append(e)
    return out


def _norm_to(x: str) -> str:
    return (x or "").strip().lower()


def _norm_file(x: str) -> str:
    """Ursprungsdatei auf Basename normalisieren (Pfad-Präfix wie 'E-Mails/' egal)."""
    return (x or "").replace("\\", "/").rsplit("/", 1)[-1].strip().lower()


def find_pending_duplicate(to: str, original_mail_file: str) -> dict | None:
    """Existierender **pending**-Entwurf für dieselbe (Empfänger + Ursprungsmail)?

    Verhindert, dass ein Triage-Re-Lauf (z.B. nach 'blocked'/Recovery oder ein
    LLM-Schleifen-Re-Draft) für dieselbe Kundenmail einen zweiten Entwurf anlegt
    und Walter erneut eine Freigabe-Mail schickt. Vergleich normalisiert: Empfänger
    strip/lower, Ursprungsdatei per Basename. Nur `pending` blockt — verbrauchte
    Einträge (sent/superseded/…) nicht."""
    tgt_to, tgt_file = _norm_to(to), _norm_file(original_mail_file)
    if not tgt_file:
        return None
    for e in list_pending():
        if _norm_to(e.get("to")) == tgt_to and _norm_file(e.get("original_mail_file")) == tgt_file:
            return e
    return None


def mark(token: str, status: str, **extra) -> dict:
    e = load(token)
    if e is None:
        raise KeyError(token)
    e["status"] = status
    e.update(extra)
    save(e)
    return e


def expire_stale(ttl_days: int = 7, now: datetime | None = None) -> list[str]:
    now = now or datetime.now()
    cutoff = now - timedelta(days=ttl_days)
    expired = []
    for e in list_pending():
        try:
            created = datetime.fromisoformat(e["created"])
        except (ValueError, KeyError):
            continue
        if created < cutoff:
            mark(e["token"], "expired")
            expired.append(e["token"])
    return expired
