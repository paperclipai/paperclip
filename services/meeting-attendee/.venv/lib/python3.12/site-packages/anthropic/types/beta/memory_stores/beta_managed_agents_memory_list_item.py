# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Annotated, TypeAlias

from ...._utils import PropertyInfo
from .beta_managed_agents_memory import BetaManagedAgentsMemory
from .beta_managed_agents_memory_prefix import BetaManagedAgentsMemoryPrefix

__all__ = ["BetaManagedAgentsMemoryListItem"]

BetaManagedAgentsMemoryListItem: TypeAlias = Annotated[
    Union[BetaManagedAgentsMemory, BetaManagedAgentsMemoryPrefix], PropertyInfo(discriminator="type")
]
