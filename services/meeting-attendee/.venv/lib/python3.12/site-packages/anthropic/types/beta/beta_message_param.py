# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Iterable
from typing_extensions import Literal, Required, TypedDict

from .beta_content_block_param import BetaContentBlockParam

__all__ = ["BetaMessageParam"]


class BetaMessageParam(TypedDict, total=False):
    content: Required[Union[str, Iterable[BetaContentBlockParam]]]

    role: Required[Literal["user", "assistant"]]
