# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

from .raw_encoding import RawEncoding

__all__ = ["RawOutputFormatParam"]


class RawOutputFormatParam(TypedDict, total=False):
    encoding: Required[RawEncoding]

    sample_rate: Required[Literal[8000, 16000, 22050, 24000, 44100, 48000]]
