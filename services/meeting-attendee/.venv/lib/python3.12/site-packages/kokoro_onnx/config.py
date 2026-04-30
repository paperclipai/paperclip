import json
from dataclasses import dataclass
from pathlib import Path

MAX_PHONEME_LENGTH = 510
SAMPLE_RATE = 24000


@dataclass
class EspeakConfig:
    lib_path: str | None = None
    data_path: str | None = None


class KoKoroConfig:
    def __init__(
        self,
        model_path: str,
        voices_path: str,
        espeak_config: EspeakConfig | None = None,
    ):
        self.model_path = model_path
        self.voices_path = voices_path
        self.espeak_config = espeak_config

    def validate(self):
        if not Path(self.voices_path).exists():
            error_msg = f"Voices file not found at {self.voices_path}"
            error_msg += (
                "\nYou can download the voices file using the following command:"
            )
            error_msg += "\nwget https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"
            raise FileNotFoundError(error_msg)

        if not Path(self.model_path).exists():
            error_msg = f"Model file not found at {self.model_path}"
            error_msg += "\nYou can download the model file from https://github.com/thewh1teagle/kokoro-onnx/releases"
            raise FileNotFoundError(error_msg)


def get_vocab():
    with open(Path(__file__).parent / "config.json", encoding="utf-8") as fp:
        config = json.load(fp)
        return config["vocab"]


DEFAULT_VOCAB = get_vocab()
