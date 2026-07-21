# tools/voice-echo-bot/llm.py
"""Chat-LLM via lokales LM Studio (OpenAI-kompatibel, stdlib urllib).

Kein API-Key nötig (lokal gebunden). `chat()` gibt den reinen Text der
ersten Choice zurück und wirft bei jedem Transport-/Format-Problem eine
`LlmError`, damit der Bot sauber einen Fallback-Text schicken kann.
"""
import json
import urllib.error
import urllib.request

LMSTUDIO_URL = "http://127.0.0.1:1234/v1/chat/completions"
DEFAULT_MODEL = "gemma-4-31b-it-mlx"
DEFAULT_TEMPERATURE = 0.3


class LlmError(Exception):
    """LM Studio nicht erreichbar oder Antwort unbrauchbar."""


def chat(messages, model=DEFAULT_MODEL, temperature=DEFAULT_TEMPERATURE,
         url=LMSTUDIO_URL, timeout=90):
    """Schickt `messages` (OpenAI-Format) an LM Studio, liefert content-String."""
    body = json.dumps({
        "model": model,
        "messages": messages,
        "temperature": temperature,
    }).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:  # 4xx/5xx
        raise LlmError("LM Studio HTTP {}".format(exc.code)) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise LlmError("LM Studio nicht erreichbar: {}".format(exc)) from exc
    except (ValueError, json.JSONDecodeError) as exc:
        raise LlmError("LM Studio Antwort nicht lesbar: {}".format(exc)) from exc
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise LlmError("LM Studio Antwort ohne content") from exc
    if not isinstance(content, str) or not content.strip():
        raise LlmError("LM Studio content leer")
    return content.strip()
