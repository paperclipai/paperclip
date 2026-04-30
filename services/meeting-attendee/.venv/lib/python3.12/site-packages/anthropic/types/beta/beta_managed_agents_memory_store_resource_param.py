# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaManagedAgentsMemoryStoreResourceParam"]


class BetaManagedAgentsMemoryStoreResourceParam(TypedDict, total=False):
    """Parameters for attaching a memory store to an agent session."""

    memory_store_id: Required[str]
    """The memory store ID (memstore\\__...).

    Must belong to the caller's organization and workspace.
    """

    type: Required[Literal["memory_store"]]

    access: Optional[Literal["read_write", "read_only"]]
    """Access mode for an attached memory store."""

    instructions: Optional[str]
    """Per-attachment guidance for the agent on how to use this store.

    Rendered into the memory section of the system prompt. Max 4096 chars.
    """
