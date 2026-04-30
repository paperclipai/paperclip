# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Dict, List, Union, Optional
from typing_extensions import Required, Annotated, TypeAlias, TypedDict

from ...._utils import PropertyInfo
from ...anthropic_beta_param import AnthropicBetaParam
from .beta_managed_agents_mcp_oauth_create_params import BetaManagedAgentsMCPOAuthCreateParams
from .beta_managed_agents_static_bearer_create_params import BetaManagedAgentsStaticBearerCreateParams

__all__ = ["CredentialCreateParams", "Auth"]


class CredentialCreateParams(TypedDict, total=False):
    auth: Required[Auth]
    """Authentication details for creating a credential."""

    display_name: Optional[str]
    """Human-readable name for the credential. Up to 255 characters."""

    metadata: Dict[str, str]
    """Arbitrary key-value metadata to attach to the credential.

    Maximum 16 pairs, keys up to 64 chars, values up to 512 chars.
    """

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""


Auth: TypeAlias = Union[BetaManagedAgentsMCPOAuthCreateParams, BetaManagedAgentsStaticBearerCreateParams]
