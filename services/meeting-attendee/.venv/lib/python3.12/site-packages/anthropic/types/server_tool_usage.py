# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from .._models import BaseModel

__all__ = ["ServerToolUsage"]


class ServerToolUsage(BaseModel):
    web_fetch_requests: int
    """The number of web fetch tool requests."""

    web_search_requests: int
    """The number of web search tool requests."""
