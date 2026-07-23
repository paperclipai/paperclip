from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from pathlib import Path

ENV_PATH = Path.home() / ".paperclip" / "voice-echo-bot.env"
TENANTS_PATH = Path.home() / ".paperclip" / "voice-echo-tenants.json"


def read_env_value(path, key: str):
    """Einfacher KEY=VALUE-Leser. Fehlende Datei/Key -> None, nie werfen."""
    try:
        for line in Path(path).read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            if k.strip() == key:
                return v.strip()
    except OSError:
        return None
    return None


def resolve_chat_id(tenants_path, vault: str = "whitestag"):
    """Chat-ID des Mandanten mit passendem vault (die JSON ist nach Chat-ID gekeyed)."""
    try:
        data = json.loads(Path(tenants_path).read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    for chat_id, entry in data.items():
        if isinstance(entry, dict) and entry.get("vault") == vault:
            return str(chat_id)
    return None


def send_telegram(text: str, token: str, chat_id: str, opener=urllib.request.urlopen) -> bool:
    """Nachricht senden. Fail-soft: Fehler -> False, nie werfen."""
    try:
        data = urllib.parse.urlencode({"chat_id": chat_id, "text": text}).encode()
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{token}/sendMessage", data=data
        )
        with opener(req, timeout=30):
            return True
    except Exception:
        return False


def send_digest(text: str, env_path=ENV_PATH, tenants_path=TENANTS_PATH,
                opener=urllib.request.urlopen) -> bool:
    """Digest an Walters Jarvis-Chat. Fail-soft — der Lauf darf daran nie scheitern."""
    token = read_env_value(env_path, "TELEGRAM_BOT_TOKEN")
    chat_id = resolve_chat_id(tenants_path)
    if not token or not chat_id:
        return False
    return send_telegram(text, token, chat_id, opener=opener)
