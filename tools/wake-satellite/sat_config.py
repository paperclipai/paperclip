# tools/wake-satellite/sat_config.py
"""Konstanten des Wake-Word-Satelliten (Walter / WHITESTAG, Mac Studio)."""
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

WAKE_THRESHOLD = 0.5
# openwakeword lädt .tflite-Modelle nur über das eigenständige Paket
# `tflite_runtime` — auf macOS arm64 gibt es dafür kein Wheel. Deshalb ONNX-
# Backend (onnxruntime, kommt als openwakeword-Abhängigkeit mit). "hey_jarvis"
# ist ein offizielles openwakeword-Modell; deploy.sh lädt via download_models
# die passenden .onnx (Wakeword + Feature-Modelle) in den openwakeword-
# Ressourcenordner, von wo der Kurzname aufgelöst wird.
INFERENCE_FRAMEWORK = "onnx"
WAKE_MODELS = ["hey_jarvis"]

SAMPLE_RATE = 16000
FRAME_SAMPLES = 1280
# Rollender Audio-Vorpuffer: die letzten ~1,2 s VOR dem Wake-Treffer werden
# der Aufnahme vorangestellt, damit ein flüssig gesprochenes „Hey Jarvis, <Befehl>"
# nicht am Anfang abgeschnitten wird (Wake-Erkennungs-Latenz + Bestätigungston).
PREROLL_SEC = 1.2
PREROLL_FRAMES = int(PREROLL_SEC * SAMPLE_RATE / FRAME_SAMPLES)  # ~15
FOLLOWUP_WINDOW_SEC = 6
FOLLOWUP_WINDOW_FRAMES = int(FOLLOWUP_WINDOW_SEC * SAMPLE_RATE / FRAME_SAMPLES)  # 75
PLAYBACK_COOLDOWN_SEC = 1.0
MAX_HISTORY_MESSAGES = 16

HOMEPOD_DEVICE = "Homepod Studio"
TTS_FORMAT = "mp3_44100_128"

# Antwort-LLM: die QAT-gemma liegt resident auf der RTX Pro 6000 (der PII-
# Classifier hält sie 24/7 warm) → konstant ~2 s statt der Mac-Variante
# `google/gemma-4-12b`, die unter Studio-RAM-Contention verdrängt wird und
# beim Nachladen 20 s+ reisst. Gleiche gemma-4-12b-Qualität. Nur der Satellit
# nutzt sie; der Telegram-Jarvis bleibt auf seinem Env-/Default-Modell.
CHAT_MODEL = "google/gemma-4-12b-qat"

# Mandant fest verdrahtet.
TENANT = {
    "name": "Walter / WHITESTAG",
    "company_id": "9cebf3cf-efe8-4597-a400-f06488900a87",
    "ceo_agent_id": "506c873e-3a40-4483-9a45-0eb0fa1554bb",
    "vault": "whitestag",
}
