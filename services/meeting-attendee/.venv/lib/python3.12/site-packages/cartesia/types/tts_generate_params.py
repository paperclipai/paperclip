# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Optional
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .model_speed import ModelSpeed
from .supported_language import SupportedLanguage
from .voice_specifier_param import VoiceSpecifierParam
from .generation_config_param import GenerationConfigParam
from .raw_output_format_param import RawOutputFormatParam

__all__ = [
    "TTSGenerateParams",
    "OutputFormat",
    "OutputFormatRawOutputFormat",
    "OutputFormatWavOutputFormat",
    "OutputFormatMP3OutputFormat",
]


class TTSGenerateParams(TypedDict, total=False):
    model_id: Required[str]
    """The ID of the model to use for the generation.

    See [Models](/build-with-cartesia/tts-models) for available models.
    """

    output_format: Required[OutputFormat]

    transcript: Required[str]

    voice: Required[VoiceSpecifierParam]

    generation_config: GenerationConfigParam
    """Configure the various attributes of the generated speech.

    These are only for `sonic-3` and have no effect on earlier models.

    See
    [Volume, Speed, and Emotion in Sonic-3](/build-with-cartesia/sonic-3/volume-speed-emotion)
    for a guide on this option.
    """

    language: Optional[SupportedLanguage]
    """The language that the given voice should speak the transcript in.

    For valid options, see [Models](/build-with-cartesia/tts-models).
    """

    pronunciation_dict_id: Optional[str]
    """The ID of a pronunciation dictionary to use for the generation.

    Pronunciation dictionaries are supported by `sonic-3` models and newer.
    """

    save: Optional[bool]
    """Whether to save the generated audio file.

    When true, the response will include a `Cartesia-File-ID` header.
    """

    speed: ModelSpeed
    """Use `generation_config.speed` for sonic-3. Speed setting for the model.

    Defaults to `normal`. This feature is experimental and may not work for all
    voices. Influences the speed of the generated speech. Faster speeds may reduce
    hallucination rate.
    """


class OutputFormatRawOutputFormat(RawOutputFormatParam, total=False):
    container: Literal["raw"]


class OutputFormatWavOutputFormat(RawOutputFormatParam, total=False):
    container: Literal["wav"]


class OutputFormatMP3OutputFormat(TypedDict, total=False):
    bit_rate: Required[Literal[32000, 64000, 96000, 128000, 192000]]

    sample_rate: Required[Literal[8000, 16000, 22050, 24000, 44100, 48000]]

    container: Literal["mp3"]


OutputFormat: TypeAlias = Union[OutputFormatRawOutputFormat, OutputFormatWavOutputFormat, OutputFormatMP3OutputFormat]
