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


# --- Rückkanal + Mehrmandanten ---
TENANTS_PATH = os.path.expanduser("~/.paperclip/voice-echo-tenants.json")
STATE_PATH = os.path.expanduser("~/.paperclip/voice-echo-state.json")
DECISION_LABEL = "entscheidung-noetig"
POLL_INTERVAL_SEC = 60
LONGPOLL_TIMEOUT_SEC = 25

# --- Antwort-Modus (Text/Voice) + ElevenLabs-TTS ---
REPLY_MODE_PATH = os.path.expanduser("~/.paperclip/voice-echo-reply-mode.json")
ELEVEN_VOICE_ID = "VBhW9TV6mNHCxbcqSl17"
ELEVEN_MODEL = "eleven_turbo_v2_5"
ELEVEN_LANGUAGE = "de"  # feste Sprache — verhindert Auto-Sprachwechsel bei Namen/Zahlen
ELEVEN_TTS_URL = (
    "https://api.elevenlabs.io/v1/text-to-speech/"
    + ELEVEN_VOICE_ID
    + "?output_format=opus_48000_64"
)
