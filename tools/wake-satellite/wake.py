"""openwakeword-Wrapper: Audio-Frames -> Wake-Word-Detektion.

Kapselt Modell-Laden und Schwellenprüfung. Kennt weder Mikrofon noch IO —
int16-Frame rein, (wort, score) über der Schwelle oder None raus. Dadurch
ohne Audio-Hardware testbar (Model-Fabrik injizierbar)."""

DEFAULT_THRESHOLD = 0.5
DEFAULT_REQUIRED_HITS = 1     # 1 = jeder Frame über der Schwelle löst aus


def _default_factory(**kwargs):
    from openwakeword.model import Model
    return Model(**kwargs)


class WakeDetector:
    def __init__(self, model_paths, threshold=DEFAULT_THRESHOLD,
                 inference_framework="onnx", model_factory=None,
                 required_hits=DEFAULT_REQUIRED_HITS):
        factory = model_factory or _default_factory
        self._model = factory(wakeword_models=list(model_paths),
                              inference_framework=inference_framework)
        self.threshold = threshold
        self.required_hits = required_hits
        self._streak = 0

    def process(self, frame):
        scores = self._model.predict(frame)
        best_word, best_score = None, -1.0
        for word, score in scores.items():
            if score > best_score:
                best_word, best_score = word, float(score)
        if best_word is None or best_score < self.threshold:
            self._streak = 0
            return None
        self._streak += 1
        if self._streak < self.required_hits:
            return None
        self._streak = 0
        return (best_word, best_score)

    def reset(self):
        self._streak = 0
        self._model.reset()
