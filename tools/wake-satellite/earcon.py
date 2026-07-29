# tools/wake-satellite/earcon.py
"""Kurzer 'ich höre'-Ton. Erzeugt einmalig eine WAV (stdlib) und spielt sie
über die Standardausgabe via afplay. Nie fatal."""
import math
import os
import struct
import subprocess
import traceback
import wave

DEFAULT_PATH = os.path.expanduser("~/.paperclip/wake-satellite/earcon.wav")


def ensure_wav(path=DEFAULT_PATH, freq=880, ms=150, sample_rate=16000):
    if os.path.exists(path):
        return path
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    n = int(sample_rate * ms / 1000)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        for i in range(n):
            val = int(3000 * math.sin(2 * math.pi * freq * i / sample_rate))
            wf.writeframes(struct.pack("<h", val))
    return path


def beep(path=DEFAULT_PATH):
    try:
        ensure_wav(path)
        subprocess.run(["afplay", path], check=True, capture_output=True)
    except Exception:  # noqa: BLE001
        traceback.print_exc()


def beep_async(path=DEFAULT_PATH):
    """Wie beep(), aber NICHT blockierend: spielt den Ton im Hintergrund, damit
    die Aufnahme sofort nach dem Wake-Wort startet und der Satzanfang nicht
    abgeschnitten wird. Nie fatal."""
    try:
        ensure_wav(path)
        subprocess.Popen(["afplay", path],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:  # noqa: BLE001
        traceback.print_exc()
