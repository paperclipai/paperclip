# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List, Optional
from typing_extensions import Annotated, TypedDict

from ...._utils import PropertyInfo
from ...anthropic_beta_param import AnthropicBetaParam

__all__ = ["VersionListParams"]


class VersionListParams(TypedDict, total=False):
    limit: Optional[int]
    """Number of items to return per page.

    Defaults to `20`. Ranges from `1` to `1000`.
    """

    page: Optional[str]
    """Optionally set to the `next_page` token from the previous response."""

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""
