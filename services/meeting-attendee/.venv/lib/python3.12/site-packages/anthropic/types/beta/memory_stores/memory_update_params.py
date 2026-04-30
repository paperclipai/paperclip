# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List, Optional
from typing_extensions import Required, Annotated, TypedDict

from ...._utils import PropertyInfo
from ...anthropic_beta_param import AnthropicBetaParam
from .beta_managed_agents_memory_view import BetaManagedAgentsMemoryView
from .beta_managed_agents_precondition_param import BetaManagedAgentsPreconditionParam

__all__ = ["MemoryUpdateParams"]


class MemoryUpdateParams(TypedDict, total=False):
    memory_store_id: Required[str]

    view: BetaManagedAgentsMemoryView
    """Query parameter for view"""

    content: Optional[str]

    path: Optional[str]

    precondition: BetaManagedAgentsPreconditionParam

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""
