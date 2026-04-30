# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import TypedDict

__all__ = ["BetaMCPToolDefaultConfigParam"]


class BetaMCPToolDefaultConfigParam(TypedDict, total=False):
    """Default configuration for tools in an MCP toolset."""

    defer_loading: bool

    enabled: bool
