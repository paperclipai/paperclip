# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Iterable
from typing_extensions import Literal, Required, TypedDict

from .beta_content_block_source_content_param import BetaContentBlockSourceContentParam

__all__ = ["BetaContentBlockSourceParam"]


class BetaContentBlockSourceParam(TypedDict, total=False):
    content: Required[Union[str, Iterable[BetaContentBlockSourceContentParam]]]

    type: Required[Literal["content"]]
