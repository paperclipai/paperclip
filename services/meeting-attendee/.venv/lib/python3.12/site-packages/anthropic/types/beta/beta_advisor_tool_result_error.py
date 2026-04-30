# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaAdvisorToolResultError"]


class BetaAdvisorToolResultError(BaseModel):
    error_code: Literal[
        "max_uses_exceeded",
        "prompt_too_long",
        "too_many_requests",
        "overloaded",
        "unavailable",
        "execution_time_exceeded",
    ]

    type: Literal["advisor_tool_result_error"]
