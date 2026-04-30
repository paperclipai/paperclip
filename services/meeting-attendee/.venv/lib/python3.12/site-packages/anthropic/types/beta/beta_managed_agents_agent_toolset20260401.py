# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List
from typing_extensions import Literal

from ..._models import BaseModel
from .beta_managed_agents_agent_tool_config import BetaManagedAgentsAgentToolConfig
from .beta_managed_agents_agent_toolset_default_config import BetaManagedAgentsAgentToolsetDefaultConfig

__all__ = ["BetaManagedAgentsAgentToolset20260401"]


class BetaManagedAgentsAgentToolset20260401(BaseModel):
    configs: List[BetaManagedAgentsAgentToolConfig]

    default_config: BetaManagedAgentsAgentToolsetDefaultConfig
    """Resolved default configuration for agent tools."""

    type: Literal["agent_toolset_20260401"]
