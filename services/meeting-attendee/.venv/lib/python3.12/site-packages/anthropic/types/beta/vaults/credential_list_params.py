# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List
from typing_extensions import Annotated, TypedDict

from ...._utils import PropertyInfo
from ...anthropic_beta_param import AnthropicBetaParam

__all__ = ["CredentialListParams"]


class CredentialListParams(TypedDict, total=False):
    include_archived: bool
    """Whether to include archived credentials in the results."""

    limit: int
    """Maximum number of credentials to return per page. Defaults to 20, maximum 100."""

    page: str
    """Opaque pagination token from a previous `list_credentials` response."""

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""
