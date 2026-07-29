"""openwakeword-Wrapper: Audio-Frames -> Wake-Word-Detektion.

Kapselt Modell-Laden und Schwellenprüfung. Kennt weder Mikrofon noch IO —
int16-Frame rein, (wort, score) über der Schwelle oder None raus. Dadurch
ohne Audio-Hardware testbar (Model-Fabrik injizierbar)."""

DEFAULT_THRESHOLD = 0.5


def _default_factory(**kwargs):
    from openwakeword.model import Model
    return Model(**kwargs)


class WakeDetector:
    def __init__(self, model_paths, threshold=DEFAULT_THRESHOLD,
                 inference_framework="onnx", model_factory=None):
        factory = model_factory or _default_factory
        self._model = factory(wakeword_models=list(model_paths),
                              inference_framework=inference_framework)
        self.threshold = threshold

    def process(self, frame):
        scores = self._model.predict(frame)
        best_word, best_score = None, -1.0
        for word, score in scores.items():
            if score > best_score:
                best_word, best_score = word, float(score)
        if best_word is not None and best_score >= self.threshold:
            return (best_word, best_score)
        return None

    def reset(self):
        self._model.reset()
