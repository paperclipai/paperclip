# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Iterable, Optional
from typing_extensions import Literal, Required, TypedDict

from .beta_managed_agents_agent_tool_config_params import BetaManagedAgentsAgentToolConfigParams
from .beta_managed_agents_agent_toolset_default_config_params import BetaManagedAgentsAgentToolsetDefaultConfigParams

__all__ = ["BetaManagedAgentsAgentToolset20260401Params"]


class BetaManagedAgentsAgentToolset20260401Params(TypedDict, total=False):
    """Configuration for built-in agent tools.

    Use this to enable or disable groups of tools available to the agent.
    """

    type: Required[Literal["agent_toolset_20260401"]]

    configs: Iterable[BetaManagedAgentsAgentToolConfigParams]
    """Per-tool configuration overrides."""

    default_config: Optional[BetaManagedAgentsAgentToolsetDefaultConfigParams]
    """Default configuration for all tools in a toolset."""
