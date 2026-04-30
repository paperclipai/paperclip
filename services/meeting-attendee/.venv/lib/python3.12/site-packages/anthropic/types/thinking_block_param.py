# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["ThinkingBlockParam"]


class ThinkingBlockParam(TypedDict, total=False):
    signature: Required[str]

    thinking: Required[str]

    type: Required[Literal["thinking"]]
