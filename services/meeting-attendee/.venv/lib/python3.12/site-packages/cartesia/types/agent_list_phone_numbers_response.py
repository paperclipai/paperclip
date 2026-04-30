# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List
from datetime import datetime
from typing_extensions import TypeAlias

from .._models import BaseModel

__all__ = ["AgentListPhoneNumbersResponse", "AgentListPhoneNumbersResponseItem"]


class AgentListPhoneNumbersResponseItem(BaseModel):
    """A phone number that can be used to make calls to your agent."""

    agent_id: str
    """The ID of the agent."""

    created_at: datetime
    """The UTC timestamp when the phone number was created."""

    is_cartesia_managed: bool
    """Whether the phone number is managed by Cartesia.

    As of now, this is always true since Cartesia provisions phone numbers for you.
    """

    number: str
    """The phone number."""

    updated_at: datetime
    """The UTC timestamp when the phone number was last updated."""


AgentListPhoneNumbersResponse: TypeAlias = List[AgentListPhoneNumbersResponseItem]
