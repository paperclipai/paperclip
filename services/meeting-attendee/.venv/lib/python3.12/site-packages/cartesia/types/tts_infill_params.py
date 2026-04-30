# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .._types import FileTypes
from .raw_output_format_param import RawOutputFormatParam

__all__ = [
    "TTSInfillParams",
    "OutputFormat",
    "OutputFormatRawOutputFormat",
    "OutputFormatWavOutputFormat",
    "OutputFormatMP3OutputFormat",
]


class TTSInfillParams(TypedDict, total=False):
    language: str
    """The language of the transcript"""

    left_audio: FileTypes

    model_id: str
    """The ID of the model to use for generating audio.

    Any model other than the first `"sonic"` model is supported.
    """

    output_format: OutputFormat

    right_audio: FileTypes

    transcript: str
    """The infill text to generate"""

    voice_id: str
    """The ID of the voice to use for generating audio"""


class OutputFormatRawOutputFormat(RawOutputFormatParam, total=False):
    container: Literal["raw"]


class OutputFormatWavOutputFormat(RawOutputFormatParam, total=False):
    container: Literal["wav"]


class OutputFormatMP3OutputFormat(TypedDict, total=False):
    bit_rate: Required[Literal[32000, 64000, 96000, 128000, 192000]]

    sample_rate: Required[Literal[8000, 16000, 22050, 24000, 44100, 48000]]

    container: Literal["mp3"]


OutputFormat: TypeAlias = Union[OutputFormatRawOutputFormat, OutputFormatWavOutputFormat, OutputFormatMP3OutputFormat]
