# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .beta_managed_agents_url_image_source_param import BetaManagedAgentsURLImageSourceParam
from .beta_managed_agents_file_image_source_param import BetaManagedAgentsFileImageSourceParam
from .beta_managed_agents_base64_image_source_param import BetaManagedAgentsBase64ImageSourceParam

__all__ = ["BetaManagedAgentsImageBlockParam", "Source"]

Source: TypeAlias = Union[
    BetaManagedAgentsBase64ImageSourceParam, BetaManagedAgentsURLImageSourceParam, BetaManagedAgentsFileImageSourceParam
]


class BetaManagedAgentsImageBlockParam(TypedDict, total=False):
    """Image content specified directly as base64 data or as a reference via a URL."""

    source: Required[Source]
    """Union type for image source variants."""

    type: Required[Literal["image"]]
