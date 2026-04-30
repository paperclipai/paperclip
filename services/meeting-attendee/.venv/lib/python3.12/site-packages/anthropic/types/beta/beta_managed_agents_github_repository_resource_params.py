# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Optional
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .beta_managed_agents_branch_checkout_param import BetaManagedAgentsBranchCheckoutParam
from .beta_managed_agents_commit_checkout_param import BetaManagedAgentsCommitCheckoutParam

__all__ = ["BetaManagedAgentsGitHubRepositoryResourceParams", "Checkout"]

Checkout: TypeAlias = Union[BetaManagedAgentsBranchCheckoutParam, BetaManagedAgentsCommitCheckoutParam]


class BetaManagedAgentsGitHubRepositoryResourceParams(TypedDict, total=False):
    """Mount a GitHub repository into the session's container."""

    authorization_token: Required[str]
    """GitHub authorization token used to clone the repository."""

    type: Required[Literal["github_repository"]]

    url: Required[str]
    """Github URL of the repository"""

    checkout: Optional[Checkout]
    """Branch or commit to check out. Defaults to the repository's default branch."""

    mount_path: Optional[str]
    """Mount path in the container. Defaults to `/workspace/<repo-name>`."""
