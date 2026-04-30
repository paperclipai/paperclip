# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ...._models import BaseModel

__all__ = ["BetaManagedAgentsSessionRetriesExhausted"]


class BetaManagedAgentsSessionRetriesExhausted(BaseModel):
    """
    The turn ended because the retry budget was exhausted (`max_iterations` hit or an error escalated to `retry_status: 'exhausted'`).
    """

    type: Literal["retries_exhausted"]
