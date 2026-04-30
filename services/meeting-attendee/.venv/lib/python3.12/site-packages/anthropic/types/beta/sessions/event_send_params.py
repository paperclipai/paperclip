# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List, Iterable
from typing_extensions import Required, Annotated, TypedDict

from ...._utils import PropertyInfo
from ...anthropic_beta_param import AnthropicBetaParam
from .beta_managed_agents_event_params import BetaManagedAgentsEventParams

__all__ = ["EventSendParams"]


class EventSendParams(TypedDict, total=False):
    events: Required[Iterable[BetaManagedAgentsEventParams]]
    """Events to send to the `session`."""

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""
