# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

__all__ = ["ThinkingConfigAdaptiveParam"]


class ThinkingConfigAdaptiveParam(TypedDict, total=False):
    type: Required[Literal["adaptive"]]

    display: Optional[Literal["summarized", "omitted"]]
    """Controls how thinking content appears in the response.

    When set to `summarized`, thinking is returned normally. When set to `omitted`,
    thinking content is redacted but a signature is returned for multi-turn
    continuity. Defaults to `summarized`.
    """
