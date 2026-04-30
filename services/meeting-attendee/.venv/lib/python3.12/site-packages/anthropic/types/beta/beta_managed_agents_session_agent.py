# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List, Union, Optional
from typing_extensions import Literal, Annotated, TypeAlias

from ..._utils import PropertyInfo
from ..._models import BaseModel
from .beta_managed_agents_custom_tool import BetaManagedAgentsCustomTool
from .beta_managed_agents_mcp_toolset import BetaManagedAgentsMCPToolset
from .beta_managed_agents_custom_skill import BetaManagedAgentsCustomSkill
from .beta_managed_agents_model_config import BetaManagedAgentsModelConfig
from .beta_managed_agents_anthropic_skill import BetaManagedAgentsAnthropicSkill
from .beta_managed_agents_agent_toolset20260401 import BetaManagedAgentsAgentToolset20260401
from .beta_managed_agents_mcp_server_url_definition import BetaManagedAgentsMCPServerURLDefinition

__all__ = ["BetaManagedAgentsSessionAgent", "Skill", "Tool"]

Skill: TypeAlias = Annotated[
    Union[BetaManagedAgentsAnthropicSkill, BetaManagedAgentsCustomSkill], PropertyInfo(discriminator="type")
]

Tool: TypeAlias = Annotated[
    Union[BetaManagedAgentsAgentToolset20260401, BetaManagedAgentsMCPToolset, BetaManagedAgentsCustomTool],
    PropertyInfo(discriminator="type"),
]


class BetaManagedAgentsSessionAgent(BaseModel):
    """Resolved `agent` definition for a `session`.

    Snapshot of the `agent` at `session` creation time.
    """

    id: str

    description: Optional[str] = None

    mcp_servers: List[BetaManagedAgentsMCPServerURLDefinition]

    model: BetaManagedAgentsModelConfig
    """Model identifier and configuration."""

    name: str

    skills: List[Skill]

    system: Optional[str] = None

    tools: List[Tool]

    type: Literal["agent"]

    version: int
