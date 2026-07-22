"""Versendet den freigegebenen Entwurf verbatim an den SMTP-Relay.

Trägt das Approval-Feld, das die (geöffnete) Luna-Guard in Relay V16 verlangt.
Nur dieser Pfad kennt das Secret — Luna selbst nie."""
from __future__ import annotations
import json, urllib.error, urllib.request
from pathlib import Path

WEBHOOK = "http://localhost:5678/webhook/mailhub/send"
WEBHOOK_SECRET = "mailhub-812a27b07c73e64d7df192c98a3883eb"
SECRET_FILE = Path.home() / ".paperclip" / "state" / "luna-approval-secret"
FROM = "office@whitestag.ai"
REPLY_TO = "ws@whitestag.ai"
_secret_cache: str | None = None


def load_secret() -> str:
    global _secret_cache
    if _secret_cache is None:
        _secret_cache = SECRET_FILE.read_text(encoding="utf-8").strip()
    return _secret_cache


def build_payload(entry: dict, secret: str) -> dict:
    return {
        "from": FROM, "to": entry["to"], "subject": entry["subject"],
        "text": entry.get("body_md", ""), "html": entry["rendered_html"],
        "replyTo": REPLY_TO, "inReplyTo": entry.get("in_reply_to", ""),
        "approval": secret,
    }


def send_approved(entry: dict, *, urlopen=urllib.request.urlopen) -> tuple[int, str]:
    payload = build_payload(entry, load_secret())
    req = urllib.request.Request(
        WEBHOOK, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json", "X-Mailhub-Secret": WEBHOOK_SECRET})
    try:
        with urlopen(req, timeout=30) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:  # noqa: BLE001 — URLError/Timeout/Socket: nicht-terminal → Retry
        return 0, f"{type(e).__name__}: {e}"
