# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List, Optional
from typing_extensions import Literal, TypedDict

from .._types import FileTypes

__all__ = ["SttTranscribeParams"]


class SttTranscribeParams(TypedDict, total=False):
    encoding: Optional[Literal["pcm_s16le", "pcm_s32le", "pcm_f16le", "pcm_f32le", "pcm_mulaw", "pcm_alaw"]]
    """The encoding format to process the audio as.

    If not specified, the audio file will be decoded automatically.

    **Supported formats:**

    - `pcm_s16le` - 16-bit signed integer PCM, little-endian (recommended for best
      performance)
    - `pcm_s32le` - 32-bit signed integer PCM, little-endian
    - `pcm_f16le` - 16-bit floating point PCM, little-endian
    - `pcm_f32le` - 32-bit floating point PCM, little-endian
    - `pcm_mulaw` - 8-bit μ-law encoded PCM
    - `pcm_alaw` - 8-bit A-law encoded PCM
    """

    sample_rate: Optional[int]
    """The sample rate of the audio in Hz."""

    file: FileTypes

    language: Optional[
        Literal[
            "en",
            "zh",
            "de",
            "es",
            "ru",
            "ko",
            "fr",
            "ja",
            "pt",
            "tr",
            "pl",
            "ca",
            "nl",
            "ar",
            "sv",
            "it",
            "id",
            "hi",
            "fi",
            "vi",
            "he",
            "uk",
            "el",
            "ms",
            "cs",
            "ro",
            "da",
            "hu",
            "ta",
            "no",
            "th",
            "ur",
            "hr",
            "bg",
            "lt",
            "la",
            "mi",
            "ml",
            "cy",
            "sk",
            "te",
            "fa",
            "lv",
            "bn",
            "sr",
            "az",
            "sl",
            "kn",
            "et",
            "mk",
            "br",
            "eu",
            "is",
            "hy",
            "ne",
            "mn",
            "bs",
            "kk",
            "sq",
            "sw",
            "gl",
            "mr",
            "pa",
            "si",
            "km",
            "sn",
            "yo",
            "so",
            "af",
            "oc",
            "ka",
            "be",
            "tg",
            "sd",
            "gu",
            "am",
            "yi",
            "lo",
            "uz",
            "fo",
            "ht",
            "ps",
            "tk",
            "nn",
            "mt",
            "sa",
            "lb",
            "my",
            "bo",
            "tl",
            "mg",
            "as",
            "tt",
            "haw",
            "ln",
            "ha",
            "ba",
            "jw",
            "su",
            "yue",
        ]
    ]
    """The language of the input audio in ISO-639-1 format. Defaults to `en`."""

    model: str
    """ID of the model to use for transcription.

    Use `ink-whisper` for the latest Cartesia Whisper model.
    """

    timestamp_granularities: Optional[List[Literal["word"]]]
    """The timestamp granularities to populate for this transcription.

    Currently only `word` level timestamps are supported.
    """
