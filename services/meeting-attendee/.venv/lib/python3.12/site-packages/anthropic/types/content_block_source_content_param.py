# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union
from typing_extensions import TypeAlias

from .text_block_param import TextBlockParam
from .image_block_param import ImageBlockParam

__all__ = ["ContentBlockSourceContentParam"]

ContentBlockSourceContentParam: TypeAlias = Union[TextBlockParam, ImageBlockParam]
