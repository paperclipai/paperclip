# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List, Optional
from typing_extensions import Annotated, TypedDict

from ..._utils import PropertyInfo
from ..anthropic_beta_param import AnthropicBetaParam

__all__ = ["SkillListParams"]


class SkillListParams(TypedDict, total=False):
    limit: int
    """Number of results to return per page.

    Maximum value is 100. Defaults to 20.
    """

    page: Optional[str]
    """Pagination token for fetching a specific page of results.

    Pass the value from a previous response's `next_page` field to get the next page
    of results.
    """

    source: Optional[str]
    """Filter skills by source.

    If provided, only skills from the specified source will be returned:

    - `"custom"`: only return user-created skills
    - `"anthropic"`: only return Anthropic-created skills
    """

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""
