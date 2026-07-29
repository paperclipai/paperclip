import numpy as np
import wake


class FakeModel:
    def __init__(self, wakeword_models=None, inference_framework=None):
        self.scores = {"hey_jarvis": 0.0}
        self.reset_called = 0
    def predict(self, frame):
        return self.scores
    def reset(self):
        self.reset_called += 1


def _det(threshold=0.5, required_hits=1):
    holder = {}
    def factory(**kw):
        holder["model"] = FakeModel(**kw)
        return holder["model"]
    d = wake.WakeDetector(["hey_jarvis.tflite"], threshold=threshold,
                          required_hits=required_hits, model_factory=factory)
    return d, holder["model"]


FRAME = np.zeros(1280, dtype=np.int16)


def test_detects_above_threshold():
    d, model = _det()
    model.scores = {"hey_jarvis": 0.9}
    assert d.process(np.zeros(1280, dtype=np.int16)) == ("hey_jarvis", 0.9)


def test_none_below_threshold():
    d, model = _det()
    model.scores = {"hey_jarvis": 0.2}
    assert d.process(np.zeros(1280, dtype=np.int16)) is None


def test_picks_highest_scoring_word():
    d, model = _det()
    model.scores = {"hey_jarvis": 0.6, "hey_luna": 0.8}
    assert d.process(np.zeros(1280, dtype=np.int16)) == ("hey_luna", 0.8)


def test_required_hits_ignores_single_frame_spike():
    # Ein einzelner Frame über der Schwelle ist ein Ausreißer, kein Wake-Wort.
    d, model = _det(required_hits=2)
    model.scores = {"hey_jarvis": 0.9}
    assert d.process(FRAME) is None
    assert d.process(FRAME) == ("hey_jarvis", 0.9)


def test_required_hits_streak_resets_on_miss():
    d, model = _det(required_hits=2)
    model.scores = {"hey_jarvis": 0.9}
    d.process(FRAME)
    model.scores = {"hey_jarvis": 0.1}
    d.process(FRAME)
    model.scores = {"hey_jarvis": 0.9}
    assert d.process(FRAME) is None      # Serie war unterbrochen


def test_reset_clears_hit_streak():
    d, model = _det(required_hits=2)
    model.scores = {"hey_jarvis": 0.9}
    d.process(FRAME)
    d.reset()
    assert d.process(FRAME) is None


def test_reset_delegates():
    d, model = _det()
    d.reset()
    assert model.reset_called == 1
