# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List, Optional
from datetime import datetime

from .._models import BaseModel

__all__ = ["AgentListTemplatesResponse", "Template"]


class Template(BaseModel):
    id: str
    """The ID of the agent template."""

    created_at: datetime
    """The UTC timestamp when the agent template was created."""

    name: str
    """The name of the agent template."""

    owner_id: str
    """The ID of the owner of the agent template."""

    repo_url: str
    """The URL of the Git repository associated with the agent template."""

    root_dir: str
    """The root directory of the agent template."""

    updated_at: datetime
    """The UTC timestamp when the agent template was last updated."""

    dependencies: Optional[List[str]] = None
    """The dependencies of the agent template."""

    description: Optional[str] = None
    """The description of the agent template."""

    required_env_vars: Optional[List[str]] = None
    """The required environment variables for the agent template."""


class AgentListTemplatesResponse(BaseModel):
    templates: List[Template]
    """List of agent templates."""
