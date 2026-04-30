# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaThinkingConfigEnabledParam"]


class BetaThinkingConfigEnabledParam(TypedDict, total=False):
    budget_tokens: Required[int]
    """Determines how many tokens Claude can use for its internal reasoning process.

    Larger budgets can enable more thorough analysis for complex problems, improving
    response quality.

    Must be ≥1024 and less than `max_tokens`.

    See
    [extended thinking](https://docs.claude.com/en/docs/build-with-claude/extended-thinking)
    for details.
    """

    type: Required[Literal["enabled"]]

    display: Optional[Literal["summarized", "omitted"]]
    """Controls how thinking content appears in the response.

    When set to `summarized`, thinking is returned normally. When set to `omitted`,
    thinking content is redacted but a signature is returned for multi-turn
    continuity. Defaults to `summarized`.
    """
