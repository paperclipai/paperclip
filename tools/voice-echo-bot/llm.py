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
#
# 04.09.2026: stand auf "gemma-4-31b-it-mlx". Dieses Modell existiert seit der
# Archivierung ins NAS nicht mehr — der Ausweichpfad lief also ins Leere, und
# zwar fuer BEIDE Nutzer dieses Moduls (Wake-Satellit und Telegram-Jarvis).
# Aufgefallen ist es erst, als die LM-Link-Verbindung zur RTX anfing zu
# flattern (peer_keepalive_timeout) und der Fallback gebraucht wurde.
#
# Jetzt bewusst das lokale 12b, also dasselbe wie DEFAULT_MODEL: Die grossen
# Modelle liegen samt und sonders hinter LM Link (RTX bzw. MacBook). Genau
# deren Ausfall ist der haeufigste Fehlerfall — ein Fallback auf einem
# weiteren LM-Link-Geraet faellt dann mit aus. Lokal ist die einzige Lage, die
# den Ausfall ueberlebt. Wer hier wieder ein grosses Modell einsetzt, nimmt in
# Kauf, dass Primaer- und Ausweichpfad gemeinsam sterben.
#
# Kein qwen als Fallback: chat() liest ausschliesslich `content` und wirft bei
# leerem Feld LlmError. qwen3.6/3.8 liefern ihre Antwort in `reasoning_content`
# und lassen `content` leer — der Fallback wuerde zuverlaessig scheitern.
FALLBACK_MODEL = "google/gemma-4-12b"
DEFAULT_TEMPERATURE = 0.3
RETRY_DELAY_SEC = 5


class LlmError(Exception):
    """LM Studio nicht erreichbar oder Antwort unbrauchbar."""


_FALLBACK_UNGESETZT = object()


def chat(messages, model=DEFAULT_MODEL, temperature=DEFAULT_TEMPERATURE,
         url=LMSTUDIO_URL, timeout=90, fallback_model=_FALLBACK_UNGESETZT):
    """Wie `_call`, aber mit Wiederholung und Ausweichmodell.

    Reihenfolge: `model`, nach `RETRY_DELAY_SEC` nochmal `model`, dann
    einmal `fallback_model`. Erst danach fliegt die letzte `LlmError`.

    Ohne ausdruecklich uebergebenen `fallback_model` weicht der Default auf
    `DEFAULT_MODEL` aus, falls `FALLBACK_MODEL` dasselbe Modell waere wie
    `model` — sonst haette ausgerechnet der Aufrufer keinen Fallback, der
    das staerkste Modell direkt fuehrt (der dritte Versuch wird ja
    uebersprungen, wenn er auf dasselbe Modell zeigt). Praktisch betrifft
    das den Wake-Satelliten, wenn `sat_config.CHAT_MODEL` auf FALLBACK_MODEL
    steht: das liegt auf einem ANDEREN Geraet (LM Link), und genau dann
    braucht es ein lokales Netz darunter.

    Ein ausdruecklich uebergebener `fallback_model` bleibt unangetastet —
    auch `None` (= gar kein Fallback) und auch ein bewusst identischer.
    """
    if fallback_model is _FALLBACK_UNGESETZT:
        fallback_model = FALLBACK_MODEL
        if fallback_model == model and DEFAULT_MODEL != model:
            fallback_model = DEFAULT_MODEL
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
