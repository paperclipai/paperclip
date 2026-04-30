# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List
from typing_extensions import Required, Annotated, TypedDict

from ...._utils import PropertyInfo
from ...anthropic_beta_param import AnthropicBetaParam

__all__ = ["ResourceUpdateParams"]


class ResourceUpdateParams(TypedDict, total=False):
    session_id: Required[str]

    authorization_token: Required[str]
    """New authorization token for the resource.

    Currently only `github_repository` resources support token rotation.
    """

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""
