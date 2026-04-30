# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

from .model_speed import ModelSpeed
from .raw_encoding import RawEncoding
from .supported_language import SupportedLanguage
from .voice_specifier_param import VoiceSpecifierParam
from .generation_config_param import GenerationConfigParam

__all__ = ["TTSGenerateSseParams", "OutputFormat"]


class TTSGenerateSseParams(TypedDict, total=False):
    model_id: Required[str]
    """The ID of the model to use for the generation.

    See [Models](/build-with-cartesia/tts-models) for available models.
    """

    output_format: Required[OutputFormat]

    transcript: Required[str]

    voice: Required[VoiceSpecifierParam]

    add_phoneme_timestamps: Optional[bool]
    """Whether to return phoneme-level timestamps.

    If `false` (default), no phoneme timestamps will be produced. If `true`, the
    server will return timestamp events containing phoneme-level timing information.
    """

    add_timestamps: Optional[bool]
    """Whether to return word-level timestamps.

    If `false` (default), no word timestamps will be produced at all. If `true`, the
    server will return timestamp events containing word-level timing information.
    """

    context_id: Optional[str]
    """Optional context ID for this request."""

    generation_config: GenerationConfigParam
    """Configure the various attributes of the generated speech.

    These are only for `sonic-3` and have no effect on earlier models.

    See
    [Volume, Speed, and Emotion in Sonic-3](/build-with-cartesia/sonic-3/volume-speed-emotion)
    for a guide on this option.
    """

    language: SupportedLanguage
    """The language that the given voice should speak the transcript in.

    For valid options, see [Models](/build-with-cartesia/tts-models).
    """

    pronunciation_dict_id: Optional[str]
    """The ID of a pronunciation dictionary to use for the generation.

    Pronunciation dictionaries are supported by `sonic-3` models and newer.
    """

    speed: ModelSpeed
    """Use `generation_config.speed` for sonic-3. Speed setting for the model.

    Defaults to `normal`. This feature is experimental and may not work for all
    voices. Influences the speed of the generated speech. Faster speeds may reduce
    hallucination rate.
    """

    use_normalized_timestamps: Optional[bool]
    """Whether to use normalized timestamps (True) or original timestamps (False)."""


class OutputFormat(TypedDict, total=False):
    container: Required[Literal["raw"]]

    encoding: Required[RawEncoding]

    sample_rate: Required[Literal[8000, 16000, 22050, 24000, 44100, 48000]]
