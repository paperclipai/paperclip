# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Dict, Union, Optional
from datetime import datetime
from typing_extensions import Literal, Annotated, TypeAlias

from ...._utils import PropertyInfo
from ...._models import BaseModel
from .beta_managed_agents_mcp_oauth_auth_response import BetaManagedAgentsMCPOAuthAuthResponse
from .beta_managed_agents_static_bearer_auth_response import BetaManagedAgentsStaticBearerAuthResponse

__all__ = ["BetaManagedAgentsCredential", "Auth"]

Auth: TypeAlias = Annotated[
    Union[BetaManagedAgentsMCPOAuthAuthResponse, BetaManagedAgentsStaticBearerAuthResponse],
    PropertyInfo(discriminator="type"),
]


class BetaManagedAgentsCredential(BaseModel):
    """A credential stored in a vault.

    Sensitive fields are never returned in responses.
    """

    id: str
    """Unique identifier for the credential."""

    archived_at: Optional[datetime] = None
    """A timestamp in RFC 3339 format"""

    auth: Auth
    """Authentication details for a credential."""

    created_at: datetime
    """A timestamp in RFC 3339 format"""

    metadata: Dict[str, str]
    """Arbitrary key-value metadata attached to the credential."""

    type: Literal["vault_credential"]

    updated_at: datetime
    """A timestamp in RFC 3339 format"""

    vault_id: str
    """Identifier of the vault this credential belongs to."""

    display_name: Optional[str] = None
    """Human-readable name for the credential."""
