# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["RedactedThinkingBlockParam"]


class RedactedThinkingBlockParam(TypedDict, total=False):
    data: Required[str]

    type: Required[Literal["redacted_thinking"]]
