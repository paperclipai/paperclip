# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Dict, List, Union, Optional
from datetime import datetime
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

__all__ = ["BetaManagedAgentsAgent", "Skill", "Tool"]

Skill: TypeAlias = Annotated[
    Union[BetaManagedAgentsAnthropicSkill, BetaManagedAgentsCustomSkill], PropertyInfo(discriminator="type")
]

Tool: TypeAlias = Annotated[
    Union[BetaManagedAgentsAgentToolset20260401, BetaManagedAgentsMCPToolset, BetaManagedAgentsCustomTool],
    PropertyInfo(discriminator="type"),
]


class BetaManagedAgentsAgent(BaseModel):
    """A Managed Agents `agent`."""

    id: str

    archived_at: Optional[datetime] = None
    """A timestamp in RFC 3339 format"""

    created_at: datetime
    """A timestamp in RFC 3339 format"""

    description: Optional[str] = None

    mcp_servers: List[BetaManagedAgentsMCPServerURLDefinition]

    metadata: Dict[str, str]

    model: BetaManagedAgentsModelConfig
    """Model identifier and configuration."""

    name: str

    skills: List[Skill]

    system: Optional[str] = None

    tools: List[Tool]

    type: Literal["agent"]

    updated_at: datetime
    """A timestamp in RFC 3339 format"""

    version: int
    """The agent's current version.

    Starts at 1 and increments when the agent is modified.
    """
