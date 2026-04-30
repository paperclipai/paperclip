# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Annotated, TypeAlias

from ..._utils import PropertyInfo
from ..._models import BaseModel
from .beta_managed_agents_always_ask_policy import BetaManagedAgentsAlwaysAskPolicy
from .beta_managed_agents_always_allow_policy import BetaManagedAgentsAlwaysAllowPolicy

__all__ = ["BetaManagedAgentsMCPToolsetDefaultConfig", "PermissionPolicy"]

PermissionPolicy: TypeAlias = Annotated[
    Union[BetaManagedAgentsAlwaysAllowPolicy, BetaManagedAgentsAlwaysAskPolicy], PropertyInfo(discriminator="type")
]


class BetaManagedAgentsMCPToolsetDefaultConfig(BaseModel):
    """Resolved default configuration for all tools from an MCP server."""

    enabled: bool

    permission_policy: PermissionPolicy
    """Permission policy for tool execution."""
