# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List
from typing_extensions import Annotated, TypedDict

from .._utils import PropertyInfo
from .anthropic_beta_param import AnthropicBetaParam

__all__ = ["ModelListParams"]


class ModelListParams(TypedDict, total=False):
    after_id: str
    """ID of the object to use as a cursor for pagination.

    When provided, returns the page of results immediately after this object.
    """

    before_id: str
    """ID of the object to use as a cursor for pagination.

    When provided, returns the page of results immediately before this object.
    """

    limit: int
    """Number of items to return per page.

    Defaults to `20`. Ranges from `1` to `1000`.
    """

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""
