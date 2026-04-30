# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List
from typing_extensions import Annotated, TypedDict

from ...._utils import PropertyInfo
from ...anthropic_beta_param import AnthropicBetaParam

__all__ = ["ResourceListParams"]


class ResourceListParams(TypedDict, total=False):
    limit: int
    """Maximum number of resources to return per page (max 1000).

    If omitted, returns all resources.
    """

    page: str
    """Opaque cursor from a previous response's next_page field."""

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""
