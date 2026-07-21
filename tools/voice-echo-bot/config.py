"""Konfiguration für den Voice-Echo Jarvis-Bot (stdlib only)."""
import json
import os

API_BASE = "http://127.0.0.1:3100/api"
AUTH_JSON = os.path.expanduser("~/.paperclip/auth.json")
ENV_PATH = os.path.expanduser("~/.paperclip/voice-echo-bot.env")


def load_env(path):
    """Parst eine einfache KEY="value"-Env-Datei zu einem dict."""
    env = {}
    with open(path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            if line.startswith("export "):
                line = line[len("export "):]
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key:
                env[key] = value
    return env


def load_paperclip_token(auth_path=AUTH_JSON):
    """Liest das Board-Token aus der auth.json (auto-renewt)."""
    with open(auth_path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    return data["credentials"]["http://localhost:3100"]["token"]
