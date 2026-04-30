# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaManagedAgentsPreconditionParam"]


class BetaManagedAgentsPreconditionParam(TypedDict, total=False):
    type: Required[Literal["content_sha256"]]

    content_sha256: str
