import wave
import numpy as np
import capture


def loud(n=1280):  return (np.ones(n, dtype=np.int16) * 5000)
def quiet(n=1280): return np.zeros(n, dtype=np.int16)


def test_record_starts_at_speech_and_stops_after_silence():
    # 2 stille (ignoriert), 3 laute, dann hang=2 stille -> stop
    frames = [quiet(), quiet(), loud(), loud(), loud(), quiet(), quiet(), loud()]
    out = capture.record_until_silence(iter(frames), hang=2)
    # Startet beim ersten lauten Frame; endet nach 2 stillen; letztes loud nicht mehr
    assert len(out) == 5  # 3 loud + 2 trailing silence


def test_record_respects_max_frames():
    frames = (loud() for _ in range(1000))
    out = capture.record_until_silence(frames, max_frames=10)
    assert len(out) == 10


def test_record_empty_when_only_silence():
    out = capture.record_until_silence(iter([quiet(), quiet(), quiet()]), hang=2)
    assert out == []


def test_wait_for_speech_true_on_first_loud():
    assert capture.wait_for_speech(iter([quiet(), loud(), quiet()]), window_frames=5) is True


def test_wait_for_speech_false_after_window():
    assert capture.wait_for_speech(iter([quiet(), quiet(), quiet()]), window_frames=3) is False


def test_frames_to_wav_roundtrip(tmp_path):
    path = str(tmp_path / "a.wav")
    capture.frames_to_wav([loud(), loud()], path)
    with wave.open(path, "rb") as wf:
        assert wf.getframerate() == 16000
        assert wf.getnchannels() == 1
        assert wf.getnframes() == 2560
