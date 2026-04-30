# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List, Optional
from datetime import datetime

from .._models import BaseModel

__all__ = ["AgentSummary", "GitRepository", "PhoneNumber"]


class GitRepository(BaseModel):
    """The Git repository associated with the agent."""

    account: str
    """The account name associated with the Git repository."""

    name: str
    """The name of the Git repository."""

    provider: str
    """The provider of the Git repository, e.g., GitHub."""


class PhoneNumber(BaseModel):
    id: str
    """The ID of the phone number."""

    number: str
    """The phone number with country code included."""


class AgentSummary(BaseModel):
    """A summary of essential information about an agent."""

    id: str
    """The ID of the agent."""

    created_at: datetime
    """The date and time when the agent was created."""

    deployment_count: int
    """The number of deployments associated with the agent."""

    has_text_to_agent_run: bool
    """Whether the agent has a text-to-agent run."""

    name: str
    """
    The unique name of the agent, which can be used to identify the agent in the
    CLI.
    """

    tts_language: str
    """The language used for text-to-speech by the agent."""

    tts_voice: str
    """The text-to-speech voice used by the agent."""

    updated_at: datetime
    """The date and time when the agent was last updated."""

    deleted_at: Optional[datetime] = None
    """The date and time when the agent was deleted, if applicable."""

    description: Optional[str] = None
    """A brief description of the agent."""

    git_deploy_branch: Optional[str] = None
    """The branch of the Git repository used for deployment."""

    git_repository: Optional[GitRepository] = None
    """The Git repository associated with the agent."""

    phone_numbers: Optional[List[PhoneNumber]] = None
    """The phone numbers associated with the agent.

    Currently, you can only have one phone number per agent.
    """

    webhook_id: Optional[str] = None
    """The identifier for the webhook associated with the agent.

    Add or customize a webhook to your agent to receive events when calls are made
    to your agent via the Playground.
    """
