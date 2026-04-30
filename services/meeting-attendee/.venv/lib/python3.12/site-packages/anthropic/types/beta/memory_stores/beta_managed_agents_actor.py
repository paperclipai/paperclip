# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Annotated, TypeAlias

from ...._utils import PropertyInfo
from .beta_managed_agents_api_actor import BetaManagedAgentsAPIActor
from .beta_managed_agents_user_actor import BetaManagedAgentsUserActor
from .beta_managed_agents_session_actor import BetaManagedAgentsSessionActor

__all__ = ["BetaManagedAgentsActor"]

BetaManagedAgentsActor: TypeAlias = Annotated[
    Union[BetaManagedAgentsSessionActor, BetaManagedAgentsAPIActor, BetaManagedAgentsUserActor],
    PropertyInfo(discriminator="type"),
]
