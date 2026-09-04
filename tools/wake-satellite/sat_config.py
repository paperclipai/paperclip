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
# Ein einzelner Frame über der Schwelle ist ein Ausreißer, kein Wake-Wort: ein
# echtes „Hey Jarvis" liegt über mehrere 80-ms-Frames hinweg oben. Zwei Treffer
# in Folge kosten 80 ms Latenz und sieben einen Großteil der Fehlalarme aus.
WAKE_REQUIRED_HITS = 2

SAMPLE_RATE = 16000
FRAME_SAMPLES = 1280
# Rollender Audio-Vorpuffer: die letzten ~1,2 s VOR dem Wake-Treffer werden
# der Aufnahme vorangestellt, damit ein flüssig gesprochenes „Hey Jarvis, <Befehl>"
# nicht am Anfang abgeschnitten wird (Wake-Erkennungs-Latenz + Bestätigungston).
PREROLL_SEC = 1.2
PREROLL_FRAMES = int(PREROLL_SEC * SAMPLE_RATE / FRAME_SAMPLES)  # ~15
# Nachfrage-Fenster ohne Wake-Word: kurz + streng, damit am Schreibtisch nicht
# jedes Nebengespräch aufgeschnappt wird. Nur eine zügige, kurz anhaltende
# Anschlussfrage direkt nach Jarvis' Antwort löst eine weitere Runde aus.
FOLLOWUP_WINDOW_SEC = 2.5
FOLLOWUP_WINDOW_FRAMES = int(FOLLOWUP_WINDOW_SEC * SAMPLE_RATE / FRAME_SAMPLES)  # ~31
FOLLOWUP_MIN_SPEECH_FRAMES = 3  # ~0,24 s zusammenhängende Sprache nötig (kein kurzer Knacks)
# Deckel für die Nachfrage-Kette: nach so vielen Antworten ist ohne erneutes
# Wake-Wort Schluss. Ohne Deckel hält ein Gespräch im Raum die Schleife
# beliebig lange am Leben und Jarvis beantwortet alles Gesagte.
MAX_TURNS_PER_WAKE = 3
PLAYBACK_COOLDOWN_SEC = 1.0
MAX_HISTORY_MESSAGES = 16

# macOS bündelt AirPlay-Ausgaben unter dem einen CoreAudio-Gerät "AirPlay",
# das an das zuletzt gewählte AirPlay-Ziel (hier: HomePod Studio) routet. Ein
# per-Gerätename "Homepod Studio" existiert nicht als Ausgabegerät.
HOMEPOD_DEVICE = "AirPlay"
TTS_FORMAT = "mp3_44100_128"

# Antwort-LLM: Mistral-Small-24B (Q4) resident auf der RTX Pro 6000 (ctx 8192)
# → schnell (~1 s) UND deutlich bessere Antwortqualität als die 12B-gemma-qat.
# Auf der RTX, damit es nicht unter Studio-RAM-Contention verdrängt wird. Nur
# der Satellit nutzt es; der Telegram-Jarvis bleibt auf seinem Env-/Default-
# Modell. Modell muss geladen sein: `lms load "<ID>" --context-length 8192`.
#
# 17.08.2026 auf gemma-4-31b umgestellt (Walters Wunsch): es formuliert
# gesprochenes Deutsch natuerlicher. Der Preis ist gemessen und bewusst:
#   mistral-small-24b (RTX, lokal)  1,8 / 0,9 / 0,9 s
#   gemma-4-31b-it-mlx (MacBook)    4,1 / 3,2 / 3,2 s
# Das Modell lag auf dem MacBook (`lms ps` -> MacbookM5Mx128), der Sprachpfad
# hing damit an LM Link statt nur am Studio.
#
# 22.08.2026 auf die GGUF-Q8-Kopie derselben Gemma umgestellt, die jetzt auf
# der RTX liegt. Gleiches Modell, gleiche Sprachqualitaet, nur schneller —
# unter laufender Flottenlast gemessen (dieselben drei Fragen, ohne
# max_tokens, deshalb hoeher als die Werte oben):
#   gemma4-31b-it (RTX)              19,3 / 9,7 / 6,3 s
#   gemma-4-31b-it-mlx (MacBook)    108,1 / 32,0 /  -   s
# Das MacBook traegt weiterhin 7 aktive n8n-Workflows, zwei Reports und den
# Fallback von 14 Agenten bei ~2 GB freiem RAM; daher der Einbruch.
#
# 04.09.2026: Diese Repo-Fassung hinkte seit dem 22.08. hinterher und trug
# weiter "gemma-4-31b-it-mlx" — ein Modell, das es nach der Archivierung gar
# nicht mehr gibt. Live lief laengst die Zeile unten; ein `deploy.sh` haette
# den Satelliten also auf ein totes Modell zurueckgeworfen. Deshalb hier
# nachgezogen.
#
# Zum Fallback in llm.chat(): der steht seit dem 04.09. auf dem lokalen
# `google/gemma-4-12b`. Vorher zeigte er auf das entfernte MLX-Modell und lief
# damit ebenfalls ins Leere. Der Primaerpfad hier liegt auf der RTX und damit
# hinter LM Link — genau dessen Ausfall soll der Fallback abfangen, also muss
# er lokal liegen. Zurueck geht es mit einer Zeile.
CHAT_MODEL = "gemma4-31b-it"

# Mandant fest verdrahtet.
TENANT = {
    "name": "Walter / WHITESTAG",
    "company_id": "9cebf3cf-efe8-4597-a400-f06488900a87",
    "ceo_agent_id": "506c873e-3a40-4483-9a45-0eb0fa1554bb",
    "vault": "whitestag",
}
