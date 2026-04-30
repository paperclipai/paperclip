# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaManagedAgentsFileDocumentSourceParam"]


class BetaManagedAgentsFileDocumentSourceParam(TypedDict, total=False):
    """Document referenced by file ID."""

    file_id: Required[str]
    """ID of a previously uploaded file."""

    type: Required[Literal["file"]]
