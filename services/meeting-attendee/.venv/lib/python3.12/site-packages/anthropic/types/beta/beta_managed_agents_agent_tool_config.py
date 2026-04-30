# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Literal, Annotated, TypeAlias

from ..._utils import PropertyInfo
from ..._models import BaseModel
from .beta_managed_agents_always_ask_policy import BetaManagedAgentsAlwaysAskPolicy
from .beta_managed_agents_always_allow_policy import BetaManagedAgentsAlwaysAllowPolicy

__all__ = ["BetaManagedAgentsAgentToolConfig", "PermissionPolicy"]

PermissionPolicy: TypeAlias = Annotated[
    Union[BetaManagedAgentsAlwaysAllowPolicy, BetaManagedAgentsAlwaysAskPolicy], PropertyInfo(discriminator="type")
]


class BetaManagedAgentsAgentToolConfig(BaseModel):
    """Configuration for a specific agent tool."""

    enabled: bool

    name: Literal["bash", "edit", "read", "write", "glob", "grep", "web_fetch", "web_search"]
    """Built-in agent tool identifier."""

    permission_policy: PermissionPolicy
    """Permission policy for tool execution."""
