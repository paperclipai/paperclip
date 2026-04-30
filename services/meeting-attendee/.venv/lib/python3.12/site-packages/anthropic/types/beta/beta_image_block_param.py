# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Optional
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .beta_url_image_source_param import BetaURLImageSourceParam
from .beta_file_image_source_param import BetaFileImageSourceParam
from .beta_base64_image_source_param import BetaBase64ImageSourceParam
from .beta_cache_control_ephemeral_param import BetaCacheControlEphemeralParam

__all__ = ["BetaImageBlockParam", "Source"]

Source: TypeAlias = Union[BetaBase64ImageSourceParam, BetaURLImageSourceParam, BetaFileImageSourceParam]


class BetaImageBlockParam(TypedDict, total=False):
    source: Required[Source]

    type: Required[Literal["image"]]

    cache_control: Optional[BetaCacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""
