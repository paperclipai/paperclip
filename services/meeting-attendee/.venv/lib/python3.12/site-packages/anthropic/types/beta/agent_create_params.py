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

__all__ = ["AgentCreateParams", "Model", "Tool"]


class AgentCreateParams(TypedDict, total=False):
    model: Required[Model]
    """Model identifier.

    Accepts the
    [model string](https://platform.claude.com/docs/en/about-claude/models/overview#latest-models-comparison),
    e.g. `claude-opus-4-6`, or a `model_config` object for additional configuration
    control
    """

    name: Required[str]
    """Human-readable name for the agent. 1-256 characters."""

    description: Optional[str]
    """Description of what the agent does. Up to 2048 characters."""

    mcp_servers: Iterable[BetaManagedAgentsURLMCPServerParams]
    """MCP servers this agent connects to.

    Maximum 20. Names must be unique within the array.
    """

    metadata: Dict[str, str]
    """Arbitrary key-value metadata.

    Maximum 16 pairs, keys up to 64 chars, values up to 512 chars.
    """

    skills: Iterable[BetaManagedAgentsSkillParams]
    """Skills available to the agent. Maximum 20."""

    system: Optional[str]
    """System prompt for the agent. Up to 100,000 characters."""

    tools: Iterable[Tool]
    """Tool configurations available to the agent.

    Maximum of 128 tools across all toolsets allowed.
    """

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""


Model: TypeAlias = Union[BetaManagedAgentsModelParam, BetaManagedAgentsModelConfigParams]

Tool: TypeAlias = Union[
    BetaManagedAgentsAgentToolset20260401Params, BetaManagedAgentsMCPToolsetParams, BetaManagedAgentsCustomToolParams
]
