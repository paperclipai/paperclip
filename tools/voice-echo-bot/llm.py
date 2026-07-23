# tools/voice-echo-bot/llm.py
"""Chat-LLM via lokales LM Studio (OpenAI-kompatibel, stdlib urllib).

Kein API-Key nötig (lokal gebunden). `chat()` gibt den reinen Text der
ersten Choice zurück und wirft bei jedem Transport-/Format-Problem eine
`LlmError`, damit der Bot sauber einen Fallback-Text schicken kann.

`chat()` toleriert Kaltstarts: LM Studio lädt Modelle just-in-time, ein
grosses Modell kann dabei den Timeout reissen oder am RAM-Guardrail mit
HTTP 400 abprallen. Deshalb zweiter Versuch nach kurzer Pause (der trifft
das inzwischen geladene Modell) und danach ein Versuch auf einem kleinen,
dauerhaft warmen Fallback-Modell.
"""
import json
import time
import urllib.error
import urllib.request

LMSTUDIO_URL = "http://127.0.0.1:1234/v1/chat/completions"
# Klein (7,5 GB) und lokal auf der Studio resident: Jarvis muss nur kurze
# Sätze verstehen und ein Steuer-Token setzen. Das grosse 31b lag per LM Link
# auf dem MacBook und riss beim JIT-Kaltstart regelmässig den Timeout.
DEFAULT_MODEL = "google/gemma-4-12b"
# Ausweichmodell, falls das Primärmodell doch einmal weg ist.
FALLBACK_MODEL = "gemma-4-31b-it-mlx"
DEFAULT_TEMPERATURE = 0.3
RETRY_DELAY_SEC = 5


class LlmError(Exception):
    """LM Studio nicht erreichbar oder Antwort unbrauchbar."""


def chat(messages, model=DEFAULT_MODEL, temperature=DEFAULT_TEMPERATURE,
         url=LMSTUDIO_URL, timeout=90, fallback_model=FALLBACK_MODEL):
    """Wie `_call`, aber mit Wiederholung und Ausweichmodell.

    Reihenfolge: `model`, nach `RETRY_DELAY_SEC` nochmal `model`, dann
    einmal `fallback_model`. Erst danach fliegt die letzte `LlmError`.
    """
    attempts = [model, model]
    if fallback_model and fallback_model != model:
        attempts.append(fallback_model)
    last = None
    for index, attempt_model in enumerate(attempts):
        if index:
            time.sleep(RETRY_DELAY_SEC)
        try:
            return _call(messages, attempt_model, temperature, url, timeout)
        except LlmError as exc:
            last = exc
    raise last


def _call(messages, model, temperature, url, timeout):
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
