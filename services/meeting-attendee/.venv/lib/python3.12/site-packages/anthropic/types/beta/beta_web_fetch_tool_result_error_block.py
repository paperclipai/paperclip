# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ..._models import BaseModel
from .beta_web_fetch_tool_result_error_code import BetaWebFetchToolResultErrorCode

__all__ = ["BetaWebFetchToolResultErrorBlock"]


class BetaWebFetchToolResultErrorBlock(BaseModel):
    error_code: BetaWebFetchToolResultErrorCode

    type: Literal["web_fetch_tool_result_error"]
