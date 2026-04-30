# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List, Optional
from typing_extensions import Literal, Required, Annotated, TypedDict

from ...._utils import PropertyInfo
from ...anthropic_beta_param import AnthropicBetaParam

__all__ = ["ResourceAddParams"]


class ResourceAddParams(TypedDict, total=False):
    file_id: Required[str]
    """ID of a previously uploaded file."""

    type: Required[Literal["file"]]

    mount_path: Optional[str]
    """Mount path in the container. Defaults to `/mnt/session/uploads/<file_id>`."""

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""
