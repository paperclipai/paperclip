# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Iterable
from typing_extensions import Literal, Required, TypedDict

from .content_block_source_content_param import ContentBlockSourceContentParam

__all__ = ["ContentBlockSourceParam"]


class ContentBlockSourceParam(TypedDict, total=False):
    content: Required[Union[str, Iterable[ContentBlockSourceContentParam]]]

    type: Required[Literal["content"]]
