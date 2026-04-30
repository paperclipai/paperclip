# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union, Optional
from datetime import datetime
from typing_extensions import Literal, Annotated, TypeAlias

from ...._utils import PropertyInfo
from ...._models import BaseModel
from ..beta_managed_agents_branch_checkout import BetaManagedAgentsBranchCheckout
from ..beta_managed_agents_commit_checkout import BetaManagedAgentsCommitCheckout

__all__ = ["BetaManagedAgentsGitHubRepositoryResource", "Checkout"]

Checkout: TypeAlias = Annotated[
    Union[BetaManagedAgentsBranchCheckout, BetaManagedAgentsCommitCheckout, None], PropertyInfo(discriminator="type")
]


class BetaManagedAgentsGitHubRepositoryResource(BaseModel):
    id: str

    created_at: datetime
    """A timestamp in RFC 3339 format"""

    mount_path: str

    type: Literal["github_repository"]

    updated_at: datetime
    """A timestamp in RFC 3339 format"""

    url: str

    checkout: Optional[Checkout] = None
