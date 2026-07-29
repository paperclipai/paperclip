import numpy as np
import satellite
import sat_config


def loud(n=1280):  return (np.ones(n, dtype=np.int16) * 5000)
def quiet(n=1280): return np.zeros(n, dtype=np.int16)


def _deps():
    return {"whisper_model": "m.bin", "eleven_key": "k",
            "chat_model": "google/gemma-4-12b", "token": "tok"}


def _turn():
    """Eine Runde Sprache: ein lauter Frame, dann Stille bis zum hang-Deckel."""
    return [loud()] + [quiet()] * 10


def _sustained_followup():
    """Anhaltende Sprache im Nachfrage-Fenster (min_run=3)."""
    return [loud(), loud(), loud()]


class FakeMic:
    """Frame-Strom mit Rückstau-Semantik: `flush()` verwirft, was noch im Puffer
    liegt — wie ein neu gestarteter Mikrofon-Stream."""
    def __init__(self, backlog, live):
        self.backlog, self.live = list(backlog), list(live)

    def flush(self):
        self.backlog = []

    def __iter__(self):
        while self.backlog:
            yield self.backlog.pop(0)
        while self.live:
            yield self.live.pop(0)


def test_single_turn_speaks_answer(monkeypatch):
    spoken = []
    monkeypatch.setattr(satellite.transcribe, "transcribe", lambda wav, model: "Wie spät?")
    monkeypatch.setattr(satellite.jarvis_brain, "respond",
                        lambda text, tenant, token, model, history=None, source=None, voice_output=None: {"kind": "chat", "answer": "Kurz nach drei."})
    monkeypatch.setattr(satellite, "_speak", lambda text, deps: spoken.append(text))
    # 1 Runde Sprache, dann Nachfrage-Fenster leer -> Ende
    frames = iter([loud(), loud(), quiet(), quiet(), quiet(), quiet(), quiet(),
                   quiet(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet()])
    hist = satellite.handle_interaction(frames, _deps())
    assert spoken == ["Kurz nach drei."]
    # Chat-Antwort landet in der History
    assert hist[-1] == {"role": "assistant", "content": "Kurz nach drei."}


def test_followup_window_triggers_second_turn(monkeypatch):
    answers = iter([{"kind": "chat", "answer": "A1"}, {"kind": "chat", "answer": "A2"}])
    calls = []
    monkeypatch.setattr(satellite.transcribe, "transcribe", lambda wav, model: "frage")
    monkeypatch.setattr(satellite.jarvis_brain, "respond",
                        lambda *a, **k: (calls.append(1) or next(answers)))
    spoken = []
    monkeypatch.setattr(satellite, "_speak", lambda text, deps: spoken.append(text))
    # Runde 1 Sprache -> hang; Nachfrage-Fenster: sofort laut -> Runde 2 Sprache -> hang;
    # Nachfrage-Fenster 2: nur Stille -> Ende.
    frames = iter(
        [loud(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet()]  # Runde 1 (hang=10)
        + [loud(), loud(), loud()]                                                                          # Nachfrage 1: anhaltende Sprache (min_run=3)
        + [loud(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet()]  # Runde 2
        + [quiet()] * sat_config.FOLLOWUP_WINDOW_FRAMES                                                      # Nachfrage 2: leer
    )
    satellite.handle_interaction(frames, _deps())
    assert spoken == ["A1", "A2"]
    assert len(calls) == 2


def test_followup_rounds_are_capped(monkeypatch):
    # Ein Dauergespräch im Raum darf die Nachfrage-Schleife nicht endlos am
    # Leben halten — sonst beantwortet Jarvis nach einem Wake-Wort alles.
    monkeypatch.setattr(satellite.transcribe, "transcribe", lambda wav, model: "frage")
    monkeypatch.setattr(satellite.jarvis_brain, "respond",
                        lambda *a, **k: {"kind": "chat", "answer": "A"})
    spoken = []
    monkeypatch.setattr(satellite, "_speak", lambda text, deps: spoken.append(text))
    frames = iter((_turn() + _sustained_followup()) * 10)
    satellite.handle_interaction(frames, _deps())
    assert len(spoken) == sat_config.MAX_TURNS_PER_WAKE


def test_own_playback_backlog_does_not_trigger_followup(monkeypatch):
    # Während der Wiedergabe läuft das Mikrofon weiter; der Rückstau enthält
    # Jarvis' eigene Stimme (HomePod, AirPlay-Latenz). Der darf keine
    # Folgerunde auslösen.
    calls = []
    monkeypatch.setattr(satellite.transcribe, "transcribe", lambda wav, model: "frage")
    monkeypatch.setattr(satellite.jarvis_brain, "respond",
                        lambda *a, **k: calls.append(1) or {"kind": "chat", "answer": "A"})
    monkeypatch.setattr(satellite, "_speak", lambda text, deps: None)
    mic = FakeMic(backlog=_turn() + [loud()] * 12,
                  live=[quiet()] * sat_config.FOLLOWUP_WINDOW_FRAMES)
    deps = _deps()
    deps["flush_mic"] = mic.flush
    satellite.handle_interaction(iter(mic), deps)
    assert len(calls) == 1


def test_empty_transcript_ends_without_speaking(monkeypatch):
    monkeypatch.setattr(satellite.transcribe, "transcribe", lambda wav, model: "")
    responded = []
    monkeypatch.setattr(satellite.jarvis_brain, "respond",
                        lambda *a, **k: responded.append(1) or {"kind": "empty", "answer": "Nichts erkannt, bitte erneut."})
    spoken = []
    monkeypatch.setattr(satellite, "_speak", lambda text, deps: spoken.append(text))
    frames = iter([quiet(), quiet(), quiet()])   # nie Sprache -> record leer
    satellite.handle_interaction(frames, _deps())
    assert spoken == []          # nichts aufgenommen -> nichts gesprochen
    assert responded == []       # respond gar nicht erst aufgerufen


def test_non_remembered_kind_not_added_to_history(monkeypatch):
    monkeypatch.setattr(satellite.transcribe, "transcribe", lambda wav, model: "mach xyz")
    monkeypatch.setattr(satellite.jarvis_brain, "respond",
                        lambda *a, **k: {"kind": "unparsed_ok",
                                         "answer": "⚠️ …an den CEO weitergegeben: WHI-10"})
    spoken = []
    monkeypatch.setattr(satellite, "_speak", lambda text, deps: spoken.append(text))
    # Runde 1 Sprache (hang=10), dann Nachfrage-Fenster leer -> Ende
    frames = iter(
        [loud(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet()]
        + [quiet()] * sat_config.FOLLOWUP_WINDOW_FRAMES
    )
    hist = satellite.handle_interaction(frames, _deps())
    assert hist == []
    assert spoken == ["⚠️ …an den CEO weitergegeben: WHI-10"]


def test_token_callable_is_resolved(monkeypatch):
    seen = {}
    monkeypatch.setattr(satellite.transcribe, "transcribe", lambda wav, model: "hi")
    monkeypatch.setattr(satellite.jarvis_brain, "respond",
                        lambda text, tenant, token, model, history=None, source=None, voice_output=None: seen.update(token=token) or {"kind": "chat", "answer": "ok"})
    monkeypatch.setattr(satellite, "_speak", lambda text, deps: None)
    deps = _deps()
    deps["token"] = lambda: "AUFGELÖST"
    frames = iter([loud()] + [quiet()] * 12 + [quiet()] * sat_config.FOLLOWUP_WINDOW_FRAMES)
    satellite.handle_interaction(frames, deps)
    assert seen["token"] == "AUFGELÖST"
