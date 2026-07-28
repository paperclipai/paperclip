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


def _det(threshold=0.5):
    holder = {}
    def factory(**kw):
        holder["model"] = FakeModel(**kw)
        return holder["model"]
    d = wake.WakeDetector(["hey_jarvis.tflite"], threshold=threshold, model_factory=factory)
    return d, holder["model"]


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


def test_reset_delegates():
    d, model = _det()
    d.reset()
    assert model.reset_called == 1
