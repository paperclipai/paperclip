# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

from .cache_control_ephemeral_param import CacheControlEphemeralParam

__all__ = ["ContainerUploadBlockParam"]


class ContainerUploadBlockParam(TypedDict, total=False):
    """
    A content block that represents a file to be uploaded to the container
    Files uploaded via this block will be available in the container's input directory.
    """

    file_id: Required[str]

    type: Required[Literal["container_upload"]]

    cache_control: Optional[CacheControlEphemeralParam]
    """Create a cache control breakpoint at this content block."""
