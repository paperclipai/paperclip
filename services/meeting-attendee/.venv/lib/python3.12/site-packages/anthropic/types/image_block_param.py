# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Optional
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .url_image_source_param import URLImageSourceParam
from .base64_image_source_param import Base64ImageSourceParam
from .cache_control_ephemeral_param import CacheControlEphemeralParam

__all__ = ["ImageBlockParam", "Source"]

Source: TypeAlias = Union[Base64ImageSourceParam, URLImageSourceParam]


class ImageBlockParam(TypedDict, total=False):
    source: Required[Source]

    type: Required[Literal["image"]]

    cache_control: Optional[CacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""
