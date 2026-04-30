# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Dict, List, Union, Optional
from typing_extensions import Required, Annotated, TypeAlias, TypedDict

from ...._utils import PropertyInfo
from ...anthropic_beta_param import AnthropicBetaParam
from .beta_managed_agents_mcp_oauth_update_params import BetaManagedAgentsMCPOAuthUpdateParams
from .beta_managed_agents_static_bearer_update_params import BetaManagedAgentsStaticBearerUpdateParams

__all__ = ["CredentialUpdateParams", "Auth"]


class CredentialUpdateParams(TypedDict, total=False):
    vault_id: Required[str]

    auth: Auth
    """Updated authentication details for a credential."""

    display_name: Optional[str]
    """Updated human-readable name for the credential. 1-255 characters."""

    metadata: Optional[Dict[str, Optional[str]]]
    """Metadata patch.

    Set a key to a string to upsert it, or to null to delete it. Omitted keys are
    preserved.
    """

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""


Auth: TypeAlias = Union[BetaManagedAgentsMCPOAuthUpdateParams, BetaManagedAgentsStaticBearerUpdateParams]
