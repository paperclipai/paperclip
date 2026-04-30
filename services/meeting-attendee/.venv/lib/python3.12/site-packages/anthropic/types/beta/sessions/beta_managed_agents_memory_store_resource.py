# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from typing_extensions import Literal

from ...._models import BaseModel

__all__ = ["BetaManagedAgentsMemoryStoreResource"]


class BetaManagedAgentsMemoryStoreResource(BaseModel):
    """A memory store attached to an agent session."""

    memory_store_id: str
    """The memory store ID (memstore\\__...).

    Must belong to the caller's organization and workspace.
    """

    type: Literal["memory_store"]

    access: Optional[Literal["read_write", "read_only"]] = None
    """Access mode for an attached memory store."""

    description: Optional[str] = None
    """Description of the memory store, snapshotted at attach time.

    Rendered into the agent's system prompt. Empty string when the store has no
    description.
    """

    instructions: Optional[str] = None
    """Per-attachment guidance for the agent on how to use this store.

    Rendered into the memory section of the system prompt. Max 4096 chars.
    """

    mount_path: Optional[str] = None
    """Filesystem path where the store is mounted in the session container, e.g.

    /mnt/memory/user-preferences. Derived from the store's name. Output-only.
    """

    name: Optional[str] = None
    """Display name of the memory store, snapshotted at attach time.

    Later edits to the store's name do not propagate to this resource.
    """
