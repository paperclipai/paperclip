# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Dict, List, Union, Iterable, Optional
from typing_extensions import Required, Annotated, TypeAlias, TypedDict

from ..._utils import PropertyInfo
from ..anthropic_beta_param import AnthropicBetaParam
from .beta_managed_agents_model_param import BetaManagedAgentsModelParam
from .beta_managed_agents_skill_params import BetaManagedAgentsSkillParams
from .beta_managed_agents_custom_tool_params import BetaManagedAgentsCustomToolParams
from .beta_managed_agents_mcp_toolset_params import BetaManagedAgentsMCPToolsetParams
from .beta_managed_agents_model_config_params import BetaManagedAgentsModelConfigParams
from .beta_managed_agents_url_mcp_server_params import BetaManagedAgentsURLMCPServerParams
from .beta_managed_agents_agent_toolset20260401_params import BetaManagedAgentsAgentToolset20260401Params

__all__ = ["AgentUpdateParams", "Model", "Tool"]


class AgentUpdateParams(TypedDict, total=False):
    version: Required[int]
    """The agent's current version, used to prevent concurrent overwrites.

    Obtain this value from a create or retrieve response. The request fails if this
    does not match the server's current version.
    """

    description: Optional[str]
    """Description.

    Up to 2048 characters. Omit to preserve; send empty string or null to clear.
    """

    mcp_servers: Optional[Iterable[BetaManagedAgentsURLMCPServerParams]]
    """MCP servers.

    Full replacement. Omit to preserve; send empty array or null to clear. Names
    must be unique. Maximum 20.
    """

    metadata: Optional[Dict[str, Optional[str]]]
    """Metadata patch.

    Set a key to a string to upsert it, or to null to delete it. Omit the field to
    preserve. The stored bag is limited to 16 keys (up to 64 chars each) with values
    up to 512 chars.
    """

    model: Model
    """Model identifier.

    Accepts the
    [model string](https://platform.claude.com/docs/en/about-claude/models/overview#latest-models-comparison),
    e.g. `claude-opus-4-6`, or a `model_config` object for additional configuration
    control. Omit to preserve. Cannot be cleared.
    """

    name: str
    """Human-readable name. 1-256 characters. Omit to preserve. Cannot be cleared."""

    skills: Optional[Iterable[BetaManagedAgentsSkillParams]]
    """Skills.

    Full replacement. Omit to preserve; send empty array or null to clear.
    Maximum 20.
    """

    system: Optional[str]
    """System prompt.

    Up to 100,000 characters. Omit to preserve; send empty string or null to clear.
    """

    tools: Optional[Iterable[Tool]]
    """Tool configurations available to the agent.

    Full replacement. Omit to preserve; send empty array or null to clear. Maximum
    of 128 tools across all toolsets allowed.
    """

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""


Model: TypeAlias = Union[BetaManagedAgentsModelParam, BetaManagedAgentsModelConfigParams]

Tool: TypeAlias = Union[
    BetaManagedAgentsAgentToolset20260401Params, BetaManagedAgentsMCPToolsetParams, BetaManagedAgentsCustomToolParams
]
