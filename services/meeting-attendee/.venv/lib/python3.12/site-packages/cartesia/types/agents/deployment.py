# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from datetime import datetime

from ..._models import BaseModel

__all__ = ["Deployment"]


class Deployment(BaseModel):
    id: str
    """The unique identifier for the deployment."""

    agent_id: str
    """The ID of the agent associated with this deployment."""

    build_completed_at: datetime
    """The UTC timestamp when the build was completed."""

    build_logs: str
    """Logs generated during the build process of the deployment."""

    build_started_at: datetime
    """The UTC timestamp when the build process started."""

    created_at: datetime
    """The UTC timestamp when the deployment was created."""

    deployment_completed_at: datetime
    """The UTC timestamp when the deployment process was completed."""

    deployment_started_at: datetime
    """The UTC timestamp when the deployment process started."""

    env_var_collection_id: str
    """The ID of the environment variable collection associated with this deployment."""

    git_commit_hash: str
    """The commit hash of the Git repository for this deployment."""

    is_live: bool
    """
    True if this deployment is the live production deployment for its associated
    `agent_id`. Only one deployment per agent can be live at a time.
    """

    is_pinned: bool
    """
    Marks that this deployment is the active deployment for its associated
    `agent_id`. Only one deployment per agent can be pinned at a time. Deployments
    can be pinned even if they are not live or failed.
    """

    source_code_file_id: str
    """The ID of the source code file associated with this deployment."""

    status: str
    """The current status of the deployment.

    It can be `queued`, `inactive`, `deploy_error`, `skipped`, `build_error`,
    `building`, or `deployed`.
    """

    updated_at: datetime
    """The UTC timestamp when the deployment was last updated."""

    build_error: Optional[str] = None
    """Any error that occurred during the build process."""

    deployment_error: Optional[str] = None
    """Any error that occurred during the deployment process."""
