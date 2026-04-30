# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaFileImageSourceParam"]


class BetaFileImageSourceParam(TypedDict, total=False):
    file_id: Required[str]

    type: Required[Literal["file"]]
