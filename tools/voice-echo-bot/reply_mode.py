"""Antwort-Modus pro Chat: "text" (Default) oder "voice", atomar persistiert.

JSON-Format: {"<chat_id>": "text"|"voice"}. Fehlende/korrupte Datei ->
alle Chats Default "text", kein Crash (analog state.load_state-Robustheit).
"""
import json
import os

DEFAULT_MODE = "text"
VALID_MODES = ("text", "voice")


def _load(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError, ValueError):
        return {}


def get_mode(path, chat_id):
    mode = _load(path).get(str(chat_id))
    return mode if mode in VALID_MODES else DEFAULT_MODE


def set_mode(path, chat_id, mode):
    if mode not in VALID_MODES:
        raise ValueError("invalid reply mode: {!r}".format(mode))
    data = _load(path)
    data[str(chat_id)] = mode
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    os.replace(tmp, path)
    return mode
