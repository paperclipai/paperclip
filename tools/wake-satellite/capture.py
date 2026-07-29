"""Mikrofon-Aufnahme: Wake-Trigger-Aufnahme + Nachfrage-Fenster + wav-Export.

Energie-basierte Stille-Erkennung (kein externes VAD), damit mit synthetischen
Frames testbar. Der Mikrofon-Stream (`MicStream`) ist der einzige Hardware-Teil
und wird als Frame-Iterator in die Logik injiziert."""
import wave

import numpy as np

SAMPLE_RATE = 16000
FRAME_SAMPLES = 1280          # 80 ms @ 16 kHz
SILENCE_RMS = 500
SILENCE_HANG_FRAMES = 10      # ~0,8 s Stille beendet die Aufnahme
MAX_RECORD_FRAMES = 150       # ~12 s Deckel
# Deckel für das Warten auf den Sprachbeginn. Ohne ihn wartet eine Aufnahme
# nach einem Fehl-Wake unbegrenzt und nimmt die nächstbeste Äußerung auf —
# auch ein Nebengespräch Minuten später.
MAX_START_FRAMES = 40         # ~3,2 s


def _rms(frame):
    if len(frame) == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(frame.astype(np.float64)))))


def record_until_silence(frames, *, silence_rms=SILENCE_RMS,
                         hang=SILENCE_HANG_FRAMES, max_frames=MAX_RECORD_FRAMES,
                         max_start_frames=MAX_START_FRAMES):
    collected = []
    started = False
    silent_run = 0
    waited = 0
    for frame in frames:
        is_loud = _rms(frame) >= silence_rms
        if not started:
            if is_loud:
                started = True
                collected.append(frame)
                continue
            waited += 1
            if waited >= max_start_frames:
                break          # niemand spricht -> nichts aufnehmen
            continue
        collected.append(frame)
        silent_run = 0 if is_loud else silent_run + 1
        if silent_run >= hang or len(collected) >= max_frames:
            break
    return collected


def wait_for_speech(frames, *, window_frames, silence_rms=SILENCE_RMS, min_run=1):
    """True, sobald innerhalb von `window_frames` Frames `min_run` aufeinander-
    folgende laute Frames auftreten (gegen Fehlauslösung durch kurze Geräusche);
    sonst False. min_run=1 = jeder laute Frame genügt (altes Verhalten)."""
    run = 0
    for i, frame in enumerate(frames):
        if i >= window_frames:
            return False
        if _rms(frame) >= silence_rms:
            run += 1
            if run >= min_run:
                return True
        else:
            run = 0
    return False


def frames_to_wav(frames, path, sample_rate=SAMPLE_RATE):
    audio = np.concatenate(frames) if frames else np.zeros(0, dtype=np.int16)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(audio.astype(np.int16).tobytes())
    return path


class MicStream:  # pragma: no cover — Hardware
    """Fortlaufender 16-kHz-mono-int16-Frame-Iterator via sounddevice."""
    def __init__(self, device=None, blocksize=FRAME_SAMPLES):
        import sounddevice as sd
        self._blocksize = blocksize
        self._stream = sd.InputStream(samplerate=SAMPLE_RATE, channels=1,
                                      dtype="int16", blocksize=blocksize, device=device)
        self._stream.start()

    def read(self):
        data, _ = self._stream.read(self._blocksize)
        return np.asarray(data, dtype=np.int16).reshape(-1)

    def flush(self):
        """Verwirft den aufgelaufenen Puffer-Rückstau (Stop/Start des Streams).

        Während der Sprachausgabe wird der Stream sekundenlang nicht gelesen;
        der Rückstau enthält dann Jarvis' eigene Stimme vom HomePod. Ohne
        Flush deutet das Nachfrage-Fenster sie als Anschlussfrage."""
        self._stream.stop()
        self._stream.start()

    def __iter__(self):
        while True:
            yield self.read()
