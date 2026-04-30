# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Annotated, TypedDict

from .._types import FileTypes
from .._utils import PropertyInfo
from .raw_encoding import RawEncoding
from .output_format_container import OutputFormatContainer

__all__ = ["VoiceChangerChangeVoiceSseParams"]


class VoiceChangerChangeVoiceSseParams(TypedDict, total=False):
    clip: FileTypes

    output_format_bit_rate: Annotated[Optional[int], PropertyInfo(alias="output_format[bit_rate]")]
    """Required for `mp3` containers."""

    output_format_container: Annotated[OutputFormatContainer, PropertyInfo(alias="output_format[container]")]

    output_format_encoding: Annotated[Optional[RawEncoding], PropertyInfo(alias="output_format[encoding]")]
    """Required for `raw` and `wav` containers."""

    output_format_sample_rate: Annotated[
        Literal[8000, 16000, 22050, 24000, 44100, 48000], PropertyInfo(alias="output_format[sample_rate]")
    ]

    voice_id: Annotated[str, PropertyInfo(alias="voice[id]")]
