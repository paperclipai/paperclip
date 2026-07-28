import subprocess
import playback


class FakeRun:
    def __init__(self, fail_on=None):
        self.calls = []
        self.fail_on = fail_on or set()   # z.B. {"-s Homepod Studio"}
    def __call__(self, args, check=False, capture_output=False, text=False):
        self.calls.append(args)
        key = " ".join(args[1:])          # ohne Binary-Namen
        if any(f in " ".join(args) for f in self.fail_on):
            raise subprocess.CalledProcessError(1, args)

        class R:  # afplay/-s liefern nichts Wichtiges; -c liefert Gerätenamen
            stdout = "Alte Ausgabe\n"
        return R()


def test_play_switches_to_homepod_and_back(monkeypatch):
    fake = FakeRun()
    monkeypatch.setattr(playback.subprocess, "run", fake)
    playback.play("/tmp/x.mp3", device="Homepod Studio")
    joined = [" ".join(c) for c in fake.calls]
    assert any("SwitchAudioSource -c" in j for j in joined)          # aktuelles Gerät lesen
    assert any("-s Homepod Studio" in j for j in joined)             # umschalten
    assert any("afplay /tmp/x.mp3" in j for j in joined)             # abspielen
    assert any("-s Alte Ausgabe" in j for j in joined)               # zurückschalten


def test_play_falls_back_when_switch_fails(monkeypatch):
    fake = FakeRun(fail_on={"-s Homepod Studio"})
    monkeypatch.setattr(playback.subprocess, "run", fake)
    playback.play("/tmp/x.mp3", device="Homepod Studio")   # darf NICHT werfen
    joined = [" ".join(c) for c in fake.calls]
    # trotz Umschalt-Fehler wurde direkt abgespielt
    assert any("afplay /tmp/x.mp3" in j for j in joined)


def test_play_never_raises_when_everything_fails(monkeypatch):
    fake = FakeRun(fail_on={"afplay", "SwitchAudioSource"})
    monkeypatch.setattr(playback.subprocess, "run", fake)
    playback.play("/tmp/x.mp3")  # kein Throw
