# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaManagedAgentsFileResourceParams"]


class BetaManagedAgentsFileResourceParams(TypedDict, total=False):
    """Mount a file uploaded via the Files API into the session."""

    file_id: Required[str]
    """ID of a previously uploaded file."""

    type: Required[Literal["file"]]

    mount_path: Optional[str]
    """Mount path in the container. Defaults to `/mnt/session/uploads/<file_id>`."""
