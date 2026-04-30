# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Dict, List, Union, Iterable, Optional
from typing_extensions import Required, Annotated, TypeAlias, TypedDict

from ..._types import SequenceNotStr
from ..._utils import PropertyInfo
from ..anthropic_beta_param import AnthropicBetaParam
from .beta_managed_agents_agent_params import BetaManagedAgentsAgentParams
from .beta_managed_agents_file_resource_params import BetaManagedAgentsFileResourceParams
from .beta_managed_agents_memory_store_resource_param import BetaManagedAgentsMemoryStoreResourceParam
from .beta_managed_agents_github_repository_resource_params import BetaManagedAgentsGitHubRepositoryResourceParams

__all__ = ["SessionCreateParams", "Agent", "Resource"]


class SessionCreateParams(TypedDict, total=False):
    agent: Required[Agent]
    """Agent identifier.

    Accepts the `agent` ID string, which pins the latest version for the session, or
    an `agent` object with both id and version specified.
    """

    environment_id: Required[str]
    """ID of the `environment` defining the container configuration for this session."""

    metadata: Dict[str, str]
    """Arbitrary key-value metadata attached to the session.

    Maximum 16 pairs, keys up to 64 chars, values up to 512 chars.
    """

    resources: Iterable[Resource]
    """Resources (e.g. repositories, files) to mount into the session's container."""

    title: Optional[str]
    """Human-readable session title."""

    vault_ids: SequenceNotStr[str]
    """Vault IDs for stored credentials the agent can use during the session."""

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""


Agent: TypeAlias = Union[str, BetaManagedAgentsAgentParams]

Resource: TypeAlias = Union[
    BetaManagedAgentsGitHubRepositoryResourceParams,
    BetaManagedAgentsFileResourceParams,
    BetaManagedAgentsMemoryStoreResourceParam,
]
